//! Background service: shares this computer's agent through the relay.
//!
//! The desktop app owns a [`Service`], reads [`Shared`] to draw itself and
//! sends [`Cmd`]s. Everything async runs on a dedicated tokio runtime thread.
//!
//! The connection loop only ever does quick work: engine checks, the busy check and prompts run
//! as their own tasks, so pings, new prompts and finished answers never wait behind them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{bail, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::HeaderValue, Message};

use crate::backend;
use crate::config::{self, host_secret_key, Engine, HostConfig, MAX_SEATS};
use crate::engine::{valid_job_id, Job};
use crate::providers;
use crate::reserve::{self, Lending};
use tokenbud_core::types::*;
use tokenbud_core::{relay_url, store, user_name, RelayClient};

const PING_EVERY: Duration = Duration::from_secs(30);
/// How often the reserve looks at the clock and at whether you're using Claude Code.
const RESERVE_EVERY: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

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
    /// Bumped per engine check, so a slow old check can't overwrite a newer result.
    check_generation: AtomicU64,
    /// A busy check is running; ticks skip instead of piling up.
    busy_checking: AtomicBool,
}

impl Service {
    /// Start the service. With `share` it shares right away (you're reachable as soon as host mode
    /// is open); without, it waits stopped (e.g. when only the settings were opened).
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
            check_generation: AtomicU64::new(0),
            busy_checking: AtomicBool::new(false),
        });
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
        std::thread::Builder::new().name("tokenbud-service".into()).spawn(move || rt.block_on(run(ctx, rx, out_rx, share)))?;
        let service = Self { shared, config, tx };
        service.send(Cmd::CheckEngine);
        Ok(service)
    }

    pub fn send(&self, cmd: Cmd) {
        if self.tx.send(cmd).is_err() {
            eprintln!("tokenbud: the sharing service has stopped; restart the app");
        }
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
                Some(cmd) => handle_cmd(&ctx, cmd, &mut sharing),
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
                            let text = serde_json::to_string(&m).expect("host messages always serialize");
                            if let Err(e) = ws.send(Message::text(text)).await { break e.to_string(); }
                        }
                        _ = ping.tick() => {
                            if let Err(e) = ws.send(Message::text("ping")).await { break e.to_string(); }
                        }
                        _ = reserve_tick.tick() => spawn_reserve_check(&ctx),
                        cmd = cmds.recv() => match cmd {
                            Some(cmd) => {
                                handle_cmd(&ctx, cmd, &mut sharing);
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
                let msg = tokenbud_core::text::error_chain(&e);
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
                        handle_cmd(&ctx, cmd, &mut sharing);
                        if !sharing { break; }
                    }
                    None => return,
                },
            }
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect to the relay, getting an ID first if this computer doesn't have one there yet.
async fn connect(ctx: &Ctx) -> Result<Ws> {
    let relay_address = relay_url();
    let relay = RelayClient::new(&relay_address)?;
    let (known_id, secret) = {
        let cfg = ctx.config.read().unwrap();
        // IDs from before the ID + password version were 32 hex characters: get a new one.
        (cfg.host_id_on(&relay_address).filter(|id| is_host_id(id)), cfg.host_secret_on(&relay_address)?)
    };
    let (host_id, secret) = match (known_id, secret) {
        (Some(id), Some(secret)) => (id, secret),
        (known, _) => {
            if let Some(id) = known {
                (ctx.notify)(&format!("the secret for ID {id} is missing from secret storage; getting a new ID"));
            }
            register(ctx, &relay, &relay_address).await?
        }
    };
    let mut req = relay.connect_url(&host_id).into_client_request()?;
    req.headers_mut().insert("authorization", HeaderValue::from_str(&format!("Bearer {secret}"))?);
    match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(req)).await {
        Err(_) => bail!("timed out"),
        Ok(Ok((ws, _))) => Ok(ws),
        // The relay doesn't know this ID any more (a reset relay, or its data was cleaned up):
        // forget it, and the next attempt registers a fresh one.
        Ok(Err(tungstenite::Error::Http(resp))) if resp.status() == 401 => {
            update_config(ctx, |cfg| cfg.forget_host_id_on(&relay_address))?;
            bail!("the relay no longer knows ID {host_id}; getting a new one")
        }
        Ok(Err(e)) => Err(e.into()),
    }
}

async fn register(ctx: &Ctx, relay: &RelayClient, relay_address: &str) -> Result<(String, String)> {
    let reg = relay.register().await?;
    if !is_host_id(&reg.host_id) {
        bail!("The relay is out of date. Redeploy it: cd relay && npm run deploy");
    }
    store::set_secret(&host_secret_key(relay_address, &reg.host_id), &reg.host_secret)?;
    update_config(ctx, |cfg| cfg.set_host_id_on(relay_address, reg.host_id.clone()))?;
    Ok((reg.host_id, reg.host_secret))
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

/// Change the settings and save them. The lock is released before returning, so it can never
/// be held across an `.await`.
fn update_config(ctx: &Ctx, f: impl FnOnce(&mut HostConfig)) -> Result<()> {
    let mut cfg = ctx.config.write().unwrap();
    f(&mut cfg);
    cfg.save()
}

/// Commands are quick: anything slow (engine checks) is spawned.
fn handle_cmd(ctx: &Arc<Ctx>, cmd: Cmd, sharing: &mut bool) {
    let result: Result<()> = (|| {
        match cmd {
            Cmd::SetSharing(on) => *sharing = on,
            Cmd::NewPassword => {
                let p = config::new_password()?;
                ctx.shared.lock().unwrap().password = p;
                let _ = ctx.out.send(config_msg(ctx));
            }
            Cmd::SetSeats(n) => {
                update_config(ctx, |cfg| cfg.seats = n.clamp(1, MAX_SEATS))?;
                let _ = ctx.out.send(config_msg(ctx));
            }
            Cmd::SetEngine(engine) => {
                if !engine.allowed() {
                    bail!("Claude Code sharing is only available in development builds.");
                }
                update_config(ctx, |cfg| cfg.engine = engine)?;
                spawn_engine_check(ctx);
            }
            Cmd::Kick(session_id) => {
                let _ = ctx.out.send(HostToRelay::Kick { session_id });
            }
            Cmd::CheckEngine => spawn_engine_check(ctx),
            Cmd::SetLocal { url, model } => {
                update_config(ctx, |cfg| {
                    cfg.local_url = url.trim().to_string();
                    cfg.local_model = model.trim().to_string();
                })?;
                spawn_engine_check(ctx);
            }
            Cmd::SetProvider(id) => {
                if providers::preset(&id).is_none() {
                    bail!("unknown provider {id}");
                }
                update_config(ctx, |cfg| {
                    cfg.provider = id;
                    cfg.engine = Engine::Provider;
                })?;
                spawn_engine_check(ctx);
            }
            Cmd::SetProviderModel { provider, model } => {
                if providers::preset(&provider).is_none() {
                    bail!("unknown provider {provider}");
                }
                update_config(ctx, |cfg| match model.trim() {
                    "" => drop(cfg.provider_models.remove(&provider)),
                    m => drop(cfg.provider_models.insert(provider, m.to_string())),
                })?;
                spawn_engine_check(ctx);
            }
            Cmd::SetCustomUrl(url) => {
                update_config(ctx, |cfg| cfg.custom_url = url.trim().to_string())?;
                spawn_engine_check(ctx);
            }
            Cmd::SetReserve { max_per_hour, pause_while_busy } => {
                update_config(ctx, |cfg| {
                    cfg.max_per_hour = max_per_hour.min(config::MAX_PER_HOUR);
                    cfg.pause_while_busy = pause_while_busy;
                })?;
                spawn_reserve_check(ctx);
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        (ctx.notify)(&format!("error: {e:#}"));
    }
    (ctx.notify)("");
}

/// Check the engine (and list its models) in the background. Only the latest check's result is kept.
fn spawn_engine_check(ctx: &Arc<Ctx>) {
    let generation = ctx.check_generation.fetch_add(1, Ordering::SeqCst) + 1;
    ctx.shared.lock().unwrap().engine_check = None;
    (ctx.notify)("");
    let ctx = ctx.clone();
    tokio::spawn(async move {
        let cfg = ctx.config.read().unwrap().clone();
        let result = backend::check(&cfg).await;
        if ctx.check_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let mut s = ctx.shared.lock().unwrap();
        match result {
            Ok((description, models)) => {
                s.engine_check = Some(Ok(description));
                s.models = models;
            }
            Err(e) => {
                s.engine_check = Some(Err(format!("{e:#}")));
                s.models = vec![];
            }
        }
        drop(s);
        (ctx.notify)("");
    });
}

// ---------- the reserve ----------

/// Look again at whether you're using Claude Code (in the background), then pause or resume.
fn spawn_reserve_check(ctx: &Arc<Ctx>) {
    // Your own Claude Code use only competes with sharing when sharing runs on Claude Code too.
    let watch = {
        let cfg = ctx.config.read().unwrap();
        cfg.pause_while_busy && cfg.engine() == Engine::ClaudeCode
    };
    if !watch {
        ctx.shared.lock().unwrap().busy = false;
        apply_reserve(ctx);
        return;
    }
    if ctx.busy_checking.swap(true, Ordering::SeqCst) {
        return;
    }
    let ctx = ctx.clone();
    tokio::spawn(async move {
        let c = ctx.clone();
        let busy = tokio::task::spawn_blocking(move || reserve::claude_in_use(&mut c.sys.lock().unwrap())).await.unwrap_or(false);
        ctx.shared.lock().unwrap().busy = busy;
        ctx.busy_checking.store(false, Ordering::SeqCst);
        apply_reserve(&ctx);
    });
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
    (ctx.notify)(match want.map(|p| p.kind) {
        Some(PauseKind::Limit) => "paused: hourly limit reached",
        Some(PauseKind::Busy) => "paused: you're using Claude Code",
        None => "resumed sharing",
    });
}

// ---------- prompts ----------

fn result_error(job_id: String, error: impl Into<String>) -> HostToRelay {
    HostToRelay::Result { job_id, status: ResultStatus::Error, text: None, error: Some(error.into()) }
}

fn on_relay_message(ctx: &Arc<Ctx>, text: &str) {
    let Ok(msg) = serde_json::from_str::<RelayToHost>(text) else { return };
    match msg {
        RelayToHost::Sessions { sessions } => {
            ctx.shared.lock().unwrap().sessions = sessions;
            (ctx.notify)("");
        }
        RelayToHost::Cancel { job_id } => {
            if let Some(h) = ctx.running.lock().unwrap().remove(&job_id) {
                h.abort(); // ends the engine's process too (see reserve::OwnProcess)
            }
        }
        RelayToHost::Job { job_id, name, prompt, history, context } => {
            // Job IDs end up in folder names; a custom relay must not be able to choose a path.
            if !valid_job_id(&job_id) {
                (ctx.notify)("ignored a prompt with an invalid job id");
                return;
            }
            // The relay holds prompts back while paused; this covers one that crossed paths with the pause.
            if ctx.shared.lock().unwrap().paused.is_some() {
                let _ = ctx.out.send(result_error(job_id, "The host paused sharing for now. Try again a little later."));
                return;
            }
            // Spawn and record under one lock, so a prompt that fails at once can't finish
            // before its handle is stored (and leave it behind forever).
            let mut running = ctx.running.lock().unwrap();
            if running.contains_key(&job_id) {
                return; // already answering this one
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
                        HostToRelay::Result { job_id: job.id.clone(), status: ResultStatus::Done, text: Some(answer.text), error: None }
                    }
                    Err(e) => result_error(job.id.clone(), format!("{e:#}")),
                };
                task_ctx.running.lock().unwrap().remove(&job.id);
                let _ = task_ctx.out.send(msg);
            });
            running.insert(job_id, handle.abort_handle());
        }
    }
}

fn stop_all_jobs(ctx: &Ctx) {
    for (_, h) in ctx.running.lock().unwrap().drain() {
        h.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_host_ids() {
        assert!(is_host_id("123456789"));
        assert!(!is_host_id("12345678"));
        assert!(!is_host_id("12345678a"));
        assert!(!is_host_id("0123456789abcdef0123456789abcdef"));
    }
}
