//! Background service: shares this computer's agent through the relay.
//!
//! The desktop app owns a [`Service`], reads [`Shared`] to draw itself and
//! sends [`Cmd`]s. Everything async runs on a dedicated tokio runtime thread.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

use crate::backend::{self, Job};
use crate::config::{self, host_secret_key, Engine, HostConfig, MAX_SEATS};
use crate::reserve::{self, Lending};
use tokenbud_core::types::*;
use tokenbud_core::{relay_url, store, user_name, RelayClient};

const PING_EVERY: Duration = Duration::from_secs(30);
/// How often the reserve looks at the clock and at whether you're using Claude Code.
const RESERVE_EVERY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// Not sharing.
    Stopped,
    Connecting,
    /// Sharing: people with the ID and password can connect.
    Ready,
    /// Lost the relay; trying again.
    Retrying(String),
}

#[derive(Debug)]
pub struct Shared {
    pub status: Status,
    pub password: String,
    /// Who is connected right now.
    pub sessions: Vec<Session>,
    /// Is the engine ready? Ok(description) or Err(what to fix). None while checking.
    pub engine_check: Option<Result<String, String>>,
    /// Models the current local server or provider offers (filled by the engine check).
    pub models: Vec<String>,
    /// Prompts answered for others recently.
    pub lending: Lending,
    /// Set while the reserve has paused sharing.
    pub paused: Option<Paused>,
    /// The host is using Claude Code right now (last check).
    pub busy: bool,
}

#[derive(Debug)]
pub enum Cmd {
    SetSharing(bool),
    NewPassword,
    SetSeats(u32),
    SetEngine(Engine),
    Kick(String),
    CheckEngine,
    SetReserve { max_per_hour: u32, pause_while_busy: bool },
    SetLocal { url: String, model: String },
    SetProvider(String),
    SetProviderModel { provider: String, model: String },
    SetCustomUrl(String),
}

/// Called whenever something changed, with a line worth logging (may be empty).
pub type Notify = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct Service {
    pub shared: Arc<Mutex<Shared>>,
    pub config: Arc<RwLock<HostConfig>>,
    tx: mpsc::UnboundedSender<Cmd>,
}

struct Ctx {
    shared: Arc<Mutex<Shared>>,
    config: Arc<RwLock<HostConfig>>,
    notify: Notify,
    out: mpsc::UnboundedSender<HostToRelay>,
    running: Mutex<HashMap<String, AbortHandle>>,
    /// Kept between checks: listing processes is cheaper with a warm `System`.
    sys: Mutex<sysinfo::System>,
}

impl Service {
    /// Start the service. With `share` it shares right away (like TeamViewer, you're reachable as soon
    /// as host mode is open); without, it waits stopped (e.g. when only the settings were opened).
    pub fn start(config: HostConfig, notify: Notify, share: bool) -> Result<Self> {
        let password = config::password()?;
        let (tx, rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Mutex::new(Shared {
            status: if share { Status::Connecting } else { Status::Stopped },
            password,
            sessions: vec![],
            engine_check: None,
            models: vec![],
            lending: Lending::default(),
            paused: None,
            busy: false,
        }));
        let config = Arc::new(RwLock::new(config));
        let ctx = Arc::new(Ctx {
            shared: shared.clone(),
            config: config.clone(),
            notify,
            out: out_tx,
            running: Default::default(),
            sys: Mutex::new(sysinfo::System::new()),
        });
        std::thread::Builder::new()
            .name("tokenbud-service".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime");
                rt.block_on(run(ctx, rx, out_rx, share));
            })
            .expect("spawn service thread");
        let service = Self { shared, config, tx };
        service.send(Cmd::CheckEngine);
        Ok(service)
    }

    pub fn send(&self, cmd: Cmd) {
        let _ = self.tx.send(cmd);
    }
}

// ---------- main loop ----------

async fn run(ctx: Arc<Ctx>, mut cmds: mpsc::UnboundedReceiver<Cmd>, mut out: mpsc::UnboundedReceiver<HostToRelay>, share: bool) {
    let mut sharing = share;
    let mut backoff = Duration::from_secs(1);
    loop {
        if !sharing {
            set_status(&ctx, Status::Stopped);
            match cmds.recv().await {
                Some(cmd) => handle_cmd(&ctx, cmd, &mut sharing).await,
                None => return,
            }
            continue;
        }

        set_status(&ctx, Status::Connecting);
        match connect(&ctx).await {
            Ok(mut ws) => {
                backoff = Duration::from_secs(1);
                // Leftover messages were for the previous connection.
                while out.try_recv().is_ok() {}
                let _ = ctx.out.send(config_msg(&ctx));
                let paused = ctx.shared.lock().unwrap().paused.clone();
                let _ = ctx.out.send(HostToRelay::Pause { paused });
                set_status(&ctx, Status::Ready);
                (ctx.notify)("sharing");
                let mut ping = tokio::time::interval(PING_EVERY);
                ping.tick().await;
                let mut reserve_tick = tokio::time::interval(RESERVE_EVERY);
                let reason = loop {
                    tokio::select! {
                        msg = ws.next() => match msg {
                            Some(Ok(Message::Text(t))) => on_relay_message(&ctx, t.as_str()),
                            Some(Ok(Message::Close(frame))) => {
                                break frame.map(|f| f.reason.to_string()).filter(|r| !r.is_empty())
                                    .unwrap_or_else(|| "closed by relay".into());
                            }
                            Some(Ok(_)) => {}
                            Some(Err(e)) => break e.to_string(),
                            None => break "connection ended".into(),
                        },
                        Some(m) = out.recv() => {
                            let text = serde_json::to_string(&m).expect("serialize");
                            if let Err(e) = ws.send(Message::text(text)).await { break e.to_string(); }
                        }
                        _ = ping.tick() => {
                            if let Err(e) = ws.send(Message::text("ping")).await { break e.to_string(); }
                        }
                        _ = reserve_tick.tick() => check_reserve(&ctx).await,
                        cmd = cmds.recv() => match cmd {
                            Some(cmd) => {
                                handle_cmd(&ctx, cmd, &mut sharing).await;
                                if !sharing { let _ = ws.close(None).await; break String::new(); }
                            }
                            None => return,
                        },
                    }
                };
                // Everyone was disconnected along with us.
                stop_all_jobs(&ctx);
                ctx.shared.lock().unwrap().sessions.clear();
                if !sharing {
                    continue;
                }
                (ctx.notify)(&format!("disconnected: {reason}"));
                set_status(&ctx, Status::Retrying(reason));
            }
            Err(e) => {
                let msg = format!("{e:#}");
                (ctx.notify)(&format!("could not connect: {msg}"));
                set_status(&ctx, Status::Retrying(msg));
            }
        }

        // Wait before retrying, but stay responsive to commands.
        let sleep = tokio::time::sleep(backoff);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                cmd = cmds.recv() => match cmd {
                    Some(cmd) => {
                        handle_cmd(&ctx, cmd, &mut sharing).await;
                        if !sharing { break; }
                    }
                    None => return,
                },
            }
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect to the relay, getting an ID first if this computer doesn't have one yet.
async fn connect(ctx: &Ctx) -> Result<Ws> {
    let relay_address = relay_url();
    let relay = RelayClient::new(&relay_address)?;
    let existing = {
        let cfg = ctx.config.read().unwrap();
        // IDs from before the ID + password version were 32 hex characters: get a new one.
        cfg.host_id_on(&relay_address).filter(|id| is_host_id(id)).zip(cfg.host_secret_on(&relay_address)?)
    };
    let (host_id, secret) = match existing {
        Some(pair) => pair,
        None => {
            let reg = relay.register().await?;
            if !is_host_id(&reg.host_id) {
                bail!("The relay is out of date. Redeploy it: cd relay && npm run deploy");
            }
            store::set_secret(&host_secret_key(&relay_address, &reg.host_id), &reg.host_secret)?;
            let mut cfg = ctx.config.write().unwrap();
            cfg.set_host_id_on(&relay_address, reg.host_id.clone());
            cfg.save()?;
            (reg.host_id, reg.host_secret)
        }
    };
    let mut req = relay.connect_url(&host_id).into_client_request()?;
    req.headers_mut().insert("authorization", HeaderValue::from_str(&format!("Bearer {secret}"))?);
    let (ws, _) = tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(req))
        .await
        .map_err(|_| anyhow!("timed out"))??;
    Ok(ws)
}

fn is_host_id(id: &str) -> bool {
    id.len() == 9 && id.bytes().all(|b| b.is_ascii_digit())
}

fn config_msg(ctx: &Ctx) -> HostToRelay {
    HostToRelay::Config {
        password: ctx.shared.lock().unwrap().password.clone(),
        seats: ctx.config.read().unwrap().seats,
        name: user_name(),
    }
}

fn set_status(ctx: &Ctx, status: Status) {
    let mut s = ctx.shared.lock().unwrap();
    if s.status != status {
        s.status = status;
        drop(s);
        (ctx.notify)("");
    }
}

async fn handle_cmd(ctx: &Arc<Ctx>, cmd: Cmd, sharing: &mut bool) {
    let result: Result<()> = async {
        match cmd {
            Cmd::SetSharing(on) => *sharing = on,
            Cmd::NewPassword => {
                let p = config::new_password()?;
                ctx.shared.lock().unwrap().password = p;
                let _ = ctx.out.send(config_msg(ctx));
            }
            Cmd::SetSeats(n) => {
                let mut cfg = ctx.config.write().unwrap();
                cfg.seats = n.clamp(1, MAX_SEATS);
                cfg.save()?;
                drop(cfg);
                let _ = ctx.out.send(config_msg(ctx));
            }
            Cmd::SetEngine(engine) => {
                if !engine.allowed() {
                    bail!("Claude Code sharing is only available in development builds.");
                }
                let mut cfg = ctx.config.write().unwrap();
                cfg.engine = engine;
                cfg.save()?;
                drop(cfg);
                check_engine(ctx).await;
            }
            Cmd::Kick(session_id) => {
                let _ = ctx.out.send(HostToRelay::Kick { session_id });
            }
            Cmd::CheckEngine => check_engine(ctx).await,
            Cmd::SetLocal { url, model } => {
                let mut cfg = ctx.config.write().unwrap();
                cfg.local_url = url.trim().to_string();
                cfg.local_model = model.trim().to_string();
                cfg.save()?;
                drop(cfg);
                check_engine(ctx).await;
            }
            Cmd::SetProvider(id) => {
                if crate::providers::preset(&id).is_none() {
                    bail!("unknown provider {id}");
                }
                let mut cfg = ctx.config.write().unwrap();
                cfg.provider = id;
                cfg.engine = Engine::Provider;
                cfg.save()?;
                drop(cfg);
                check_engine(ctx).await;
            }
            Cmd::SetProviderModel { provider, model } => {
                let mut cfg = ctx.config.write().unwrap();
                match model.trim() {
                    "" => cfg.provider_models.remove(&provider),
                    m => cfg.provider_models.insert(provider, m.to_string()),
                };
                cfg.save()?;
                drop(cfg);
                check_engine(ctx).await;
            }
            Cmd::SetCustomUrl(url) => {
                let mut cfg = ctx.config.write().unwrap();
                cfg.custom_url = url.trim().to_string();
                cfg.save()?;
                drop(cfg);
                check_engine(ctx).await;
            }
            Cmd::SetReserve { max_per_hour, pause_while_busy } => {
                let mut cfg = ctx.config.write().unwrap();
                cfg.max_per_hour = max_per_hour.min(1000);
                cfg.pause_while_busy = pause_while_busy;
                cfg.save()?;
                drop(cfg);
                check_reserve(ctx).await;
            }
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        (ctx.notify)(&format!("error: {e:#}"));
    }
    (ctx.notify)("");
}

async fn check_engine(ctx: &Ctx) {
    ctx.shared.lock().unwrap().engine_check = None;
    (ctx.notify)("");
    let cfg = ctx.config.read().unwrap().clone();
    let result = backend::check(&cfg).await.map_err(|e| format!("{e:#}"));
    let models = match cfg.engine() {
        Engine::Local => crate::providers::find_local(&cfg.local_url).await.map(|s| s.models).unwrap_or_default(),
        Engine::Provider => backend::provider_models(&cfg).await.unwrap_or_default(),
        Engine::ClaudeCode => vec![],
    };
    let mut s = ctx.shared.lock().unwrap();
    s.engine_check = Some(result);
    s.models = models;
}

// ---------- the reserve ----------

/// Look again at whether you're using Claude Code, then pause or resume as needed.
async fn check_reserve(ctx: &Arc<Ctx>) {
    // Your own Claude Code use only competes with sharing when sharing runs on Claude Code too.
    let watch = {
        let cfg = ctx.config.read().unwrap();
        cfg.pause_while_busy && cfg.engine() == Engine::ClaudeCode
    };
    let busy = watch && {
        let c = ctx.clone();
        tokio::task::spawn_blocking(move || reserve::claude_in_use(&mut c.sys.lock().unwrap())).await.unwrap_or(false)
    };
    ctx.shared.lock().unwrap().busy = busy;
    apply_reserve(ctx);
}

/// Pause or resume from what's known now (the hourly count, and the last busy check).
fn apply_reserve(ctx: &Ctx) {
    let max = ctx.config.read().unwrap().max_per_hour;
    let mut s = ctx.shared.lock().unwrap();
    let want = match s.lending.limit_reached(max) {
        Some(until) => Some(reserve::limit_pause(until)),
        None if s.busy => Some(reserve::busy_pause()),
        None => None,
    };
    if s.paused == want {
        return;
    }
    s.paused = want.clone();
    drop(s);
    let _ = ctx.out.send(HostToRelay::Pause { paused: want.clone() });
    (ctx.notify)(match want {
        Some(p) if p.kind == "limit" => "paused: hourly limit reached",
        Some(_) => "paused: you're using Claude Code",
        None => "resumed sharing",
    });
}

// ---------- prompts ----------

fn on_relay_message(ctx: &Arc<Ctx>, text: &str) {
    let Ok(msg) = serde_json::from_str::<RelayToHost>(text) else { return };
    match msg {
        RelayToHost::Sessions { sessions } => {
            ctx.shared.lock().unwrap().sessions = sessions;
            (ctx.notify)("");
        }
        RelayToHost::Cancel { job_id } => {
            if let Some(h) = ctx.running.lock().unwrap().remove(&job_id) {
                h.abort(); // drops the claude process too (kill_on_drop)
            }
        }
        RelayToHost::Job { job_id, name, prompt, history, context, .. } => {
            // The relay holds prompts back while paused; this covers one that crossed paths with the pause.
            if ctx.shared.lock().unwrap().paused.is_some() {
                let error = Some("The host paused sharing for now. Try again a little later.".to_string());
                let _ = ctx.out.send(HostToRelay::Result { job_id, status: "error", text: None, error });
                return;
            }
            (ctx.notify)(&format!("prompt from {name}"));
            let job = Job { id: job_id.clone(), prompt, history, context };
            let task_ctx = ctx.clone();
            let handle = tokio::spawn(async move {
                let cfg = task_ctx.config.read().unwrap().clone();
                let msg = match backend::answer(&cfg, &job).await {
                    Ok(answer) => {
                        task_ctx.shared.lock().unwrap().lending.record(answer.cost_usd);
                        apply_reserve(&task_ctx);
                        HostToRelay::Result { job_id: job.id.clone(), status: "done", text: Some(answer.text), error: None }
                    }
                    Err(e) => HostToRelay::Result { job_id: job.id.clone(), status: "error", text: None, error: Some(format!("{e:#}")) },
                };
                task_ctx.running.lock().unwrap().remove(&job.id);
                let _ = task_ctx.out.send(msg);
            });
            ctx.running.lock().unwrap().insert(job_id, handle.abort_handle());
        }
    }
}

fn stop_all_jobs(ctx: &Ctx) {
    for (_, h) in ctx.running.lock().unwrap().drain() {
        h.abort();
    }
}
