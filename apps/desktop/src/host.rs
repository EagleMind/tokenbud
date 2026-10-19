//! Host mode: share this computer's agent. Shows the ID and password; anyone with both can prompt it.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokenbud_core::types::Session;
use tokenbud_host::config::{Engine, HostConfig};
use tokenbud_host::providers::{self, Preset};
use tokenbud_host::service::{Cmd, Service, Status};

/// The sharing service starts the first time host mode is opened, so someone who only ever
/// connects to others never shares by accident.
#[derive(Default)]
pub struct Host(Mutex<Option<Service>>, std::sync::atomic::AtomicBool);

impl Host {
    /// The service, started on first use. `share` says whether a first start begins sharing:
    /// yes from host mode, no from the settings screen.
    fn service(&self, handle: &AppHandle, share: bool) -> Result<Service, String> {
        let mut slot = self.0.lock().unwrap();
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
        let handle = handle.clone();
        let config = HostConfig::load().unwrap_or_default();
        let service = Service::start(
            config,
            Arc::new(move |_| {
                let _ = handle.emit("host-changed", ());
            }),
            share,
        )
        .map_err(|e| format!("{e:#}"))?;
        *slot = Some(service.clone());
        Ok(service)
    }

    fn send(&self, handle: &AppHandle, cmd: Cmd) -> Result<(), String> {
        self.service(handle, false)?.send(cmd);
        Ok(())
    }

    /// After the relay changed: reconnect, if sharing, so the new relay is used.
    pub fn reconnect(&self) {
        if let Some(s) = self.0.lock().unwrap().as_ref() {
            if s.shared.lock().unwrap().status != Status::Stopped {
                s.send(Cmd::SetSharing(false));
                s.send(Cmd::SetSharing(true));
            }
        }
    }

    /// Is the agent being shared right now? (Without starting anything.)
    pub fn sharing(&self) -> bool {
        self.0.lock().unwrap().as_ref().is_some_and(|s| s.shared.lock().unwrap().status != Status::Stopped)
    }
}

#[derive(Serialize)]
pub struct Check {
    ok: bool,
    text: String,
}

#[derive(Serialize)]
pub struct HostView {
    /// stopped | connecting | ready | retrying
    status: &'static str,
    detail: Option<String>,
    host_id: Option<String>,
    password: String,
    seats: u32,
    engine: Engine,
    /// The Claude Code engine is offered (development builds only).
    claude_code_allowed: bool,
    local: LocalView,
    /// The chosen cloud provider and every provider's setup.
    provider: String,
    providers: Vec<ProviderView>,
    custom_url: String,
    /// Models the current local server or provider offers.
    models: Vec<String>,
    /// None while checking.
    engine_check: Option<Check>,
    sessions: Vec<Session>,
    /// The web client people can connect from (the relay serves it).
    web_url: String,
    reserve: ReserveView,
}

/// Local model settings.
#[derive(Serialize)]
pub struct LocalView {
    url: String,
    model: String,
}

/// A cloud provider as the settings screen shows it.
#[derive(Serialize)]
pub struct ProviderView {
    #[serde(flatten)]
    preset: Preset,
    has_key: bool,
    /// Your pick for this provider ("" = its default, or the first it lists).
    model: String,
}

/// The reserve: limits, what's been lent, and whether sharing is paused because of it.
#[derive(Serialize)]
pub struct ReserveView {
    max_per_hour: u32,
    pause_while_busy: bool,
    lent_hour: u32,
    lent_day: u32,
    /// Claude Code's estimate for the last 24 hours (the API engine doesn't report one).
    cost_day: f64,
    paused: Option<tokenbud_core::types::Paused>,
}

#[tauri::command]
pub fn host_state(host: State<Host>, handle: AppHandle, share: Option<bool>) -> Result<HostView, String> {
    let share = share.unwrap_or(false);
    let service = host.service(&handle, share)?;
    // The first visit to host mode shares, even if the settings screen started the service stopped.
    if share && !host.1.swap(true, std::sync::atomic::Ordering::SeqCst) && service.shared.lock().unwrap().status == Status::Stopped {
        service.send(Cmd::SetSharing(true));
    }
    let cfg = service.config.read().unwrap().clone();
    let s = service.shared.lock().unwrap();
    let (status, detail) = match &s.status {
        Status::Stopped => ("stopped", None),
        Status::Connecting => ("connecting", None),
        Status::Ready => ("ready", None),
        Status::Retrying(e) => ("retrying", Some(e.clone())),
    };
    Ok(HostView {
        status,
        detail,
        host_id: cfg.current_host_id(),
        password: s.password.clone(),
        seats: cfg.seats,
        engine: cfg.engine(),
        claude_code_allowed: tokenbud_host::config::claude_code_allowed(),
        local: LocalView { url: cfg.local_url.clone(), model: cfg.local_model.clone() },
        provider: cfg.provider.clone(),
        providers: providers::PRESETS
            .iter()
            .map(|p| ProviderView {
                preset: *p,
                has_key: matches!(providers::get_key(p.id), Ok(Some(_))),
                model: cfg.provider_model(p.id),
            })
            .collect(),
        custom_url: cfg.custom_url.clone(),
        models: s.models.clone(),
        engine_check: s.engine_check.as_ref().map(|r| match r {
            Ok(t) => Check { ok: true, text: t.clone() },
            Err(t) => Check { ok: false, text: t.clone() },
        }),
        sessions: s.sessions.clone(),
        web_url: tokenbud_core::relay_url(),
        reserve: ReserveView {
            max_per_hour: cfg.max_per_hour,
            pause_while_busy: cfg.pause_while_busy,
            lent_hour: s.lending.last_hour(),
            lent_day: s.lending.last_day(),
            cost_day: s.lending.cost_last_day(),
            paused: s.paused.clone(),
        },
    })
}

#[tauri::command]
pub fn set_sharing(host: State<Host>, handle: AppHandle, on: bool) -> Result<(), String> {
    host.send(&handle, Cmd::SetSharing(on))
}

#[tauri::command]
pub fn new_password(host: State<Host>, handle: AppHandle) -> Result<(), String> {
    host.send(&handle, Cmd::NewPassword)
}

#[tauri::command]
pub fn set_seats(host: State<Host>, handle: AppHandle, seats: u32) -> Result<(), String> {
    host.send(&handle, Cmd::SetSeats(seats))
}

#[tauri::command]
pub fn set_engine(host: State<Host>, handle: AppHandle, engine: Engine) -> Result<(), String> {
    host.send(&handle, Cmd::SetEngine(engine))
}

#[tauri::command]
pub fn kick(host: State<Host>, handle: AppHandle, session_id: String) -> Result<(), String> {
    host.send(&handle, Cmd::Kick(session_id))
}

#[tauri::command]
pub fn check_engine(host: State<Host>, handle: AppHandle) -> Result<(), String> {
    host.send(&handle, Cmd::CheckEngine)
}

#[tauri::command]
pub fn set_local(host: State<Host>, handle: AppHandle, url: String, model: String) -> Result<(), String> {
    host.send(&handle, Cmd::SetLocal { url, model })
}

#[tauri::command]
pub fn set_reserve(host: State<Host>, handle: AppHandle, max_per_hour: u32, pause_while_busy: bool) -> Result<(), String> {
    host.send(&handle, Cmd::SetReserve { max_per_hour, pause_while_busy })
}

#[tauri::command]
pub fn set_provider(host: State<Host>, handle: AppHandle, provider: String) -> Result<(), String> {
    host.send(&handle, Cmd::SetProvider(provider))
}

#[tauri::command]
pub fn set_provider_model(host: State<Host>, handle: AppHandle, provider: String, model: String) -> Result<(), String> {
    host.send(&handle, Cmd::SetProviderModel { provider, model })
}

#[tauri::command]
pub fn set_custom_url(host: State<Host>, handle: AppHandle, url: String) -> Result<(), String> {
    host.send(&handle, Cmd::SetCustomUrl(url))
}

/// Keys go to the OS keychain, one per provider.
#[tauri::command]
pub fn save_provider_key(host: State<Host>, handle: AppHandle, provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Paste a key first.".into());
    }
    providers::set_key(&provider, key).map_err(|e| format!("{e:#}"))?;
    host.send(&handle, Cmd::CheckEngine)
}

#[tauri::command]
pub fn forget_provider_key(host: State<Host>, handle: AppHandle, provider: String) -> Result<(), String> {
    providers::forget_key(&provider).map_err(|e| format!("{e:#}"))?;
    host.send(&handle, Cmd::CheckEngine)
}
