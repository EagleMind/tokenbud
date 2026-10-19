// tokenbud: one app, two modes. Host mode shares your agent behind an ID and password;
// client mode connects to someone else's. The window is a React frontend (desktop/src/app).
//
// `tokenbud mcp` runs an MCP server on stdio instead, so your own agent can prompt a shared one.
// Pass the host with TOKENBUD_ID / TOKENBUD_PASSWORD (or --id / --password, which other users of
// this computer can see in the process list).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod client;
mod host;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokenbud_core::{custom_relay, normalize_url, relay_from_env, relay_url, set_custom_relay, AllowHttp, RelayClient, DEFAULT_RELAY_URL};

#[tauri::command]
fn is_sharing(host: State<host::Host>) -> bool {
    host.sharing()
}

#[derive(Serialize)]
struct RelayView {
    /// The relay in use.
    url: String,
    default_url: &'static str,
    /// A relay of your own is saved.
    custom: bool,
    /// TOKENBUD_RELAY is set and wins over the setting.
    from_env: bool,
}

#[tauri::command]
fn relay_state() -> RelayView {
    RelayView { url: relay_url(), default_url: DEFAULT_RELAY_URL, custom: custom_relay().is_some(), from_env: relay_from_env() }
}

/// Use a relay of your own (`None` = back to the default). It's checked first, then both modes
/// move to it: sharing reconnects, and a client session on the old relay ends.
#[tauri::command]
async fn set_relay(
    url: Option<String>,
    host: State<'_, host::Host>,
    client: State<'_, client::Client>,
    handle: AppHandle,
) -> Result<(), String> {
    let err = |e: anyhow::Error| format!("{e:#}");
    match url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) => {
            // https, or plain http only for a relay on this computer: the host secret and
            // passwords travel to it.
            let u = normalize_url(u, "https", AllowHttp::Loopback).map_err(err)?;
            RelayClient::new(&u).map_err(err)?.check().await.map_err(err)?;
            set_custom_relay(Some(&u)).map_err(err)?;
        }
        None => set_custom_relay(None).map_err(err)?,
    }
    host.reconnect();
    client::disconnect(client, handle);
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("mcp") {
        std::process::exit(match run_mcp(&args[1..]) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e:#}");
                2
            }
        });
    }

    tauri::Builder::default()
        // One fixed default size for both modes; your own size and position come back next time.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(host::Host::default())
        .manage(client::Client::load())
        .on_window_event(|window, event| {
            // Give the seat back before closing, without freezing the window while the relay answers.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(seat) = window.state::<client::Client>().take_seat() {
                    api.prevent_close();
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = tokio::time::timeout(client::CLOSE_TIMEOUT, seat.close()).await;
                        let _ = window.destroy();
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            is_sharing,
            relay_state,
            set_relay,
            host::host_state,
            host::set_sharing,
            host::new_password,
            host::set_seats,
            host::set_engine,
            host::kick,
            host::check_engine,
            host::set_provider,
            host::set_provider_model,
            host::set_custom_url,
            host::save_provider_key,
            host::forget_provider_key,
            host::set_reserve,
            host::set_local,
            client::client_state,
            client::connect,
            client::disconnect,
            client::clear_notice,
            client::send,
            client::delete_chat,
            client::add_memory,
            client::update_memory,
            client::delete_memory,
            client::set_memory_enabled,
            client::dismiss_suggestion,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tokenbud");
}

/// `mcp [--id ID] [--password PASSWORD]`, falling back to TOKENBUD_ID / TOKENBUD_PASSWORD.
fn run_mcp(args: &[String]) -> anyhow::Result<()> {
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let id = flag("--id")
        .or_else(|| std::env::var("TOKENBUD_ID").ok())
        .ok_or_else(|| anyhow::anyhow!("usage: tokenbud mcp --id <ID> --password <PASSWORD> (or set TOKENBUD_ID and TOKENBUD_PASSWORD)"))?;
    let password = flag("--password")
        .or_else(|| std::env::var("TOKENBUD_PASSWORD").ok())
        .ok_or_else(|| anyhow::anyhow!("pass --password or set TOKENBUD_PASSWORD"))?;
    tokenbud_client::normalize_id(&id)?;
    tokio::runtime::Runtime::new()?.block_on(tokenbud_client::mcp::serve(id, password))
}
