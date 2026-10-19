//! Shared pieces of tokenbud: wire types, the relay HTTP client, and local storage.

pub mod relay;
pub mod store;
pub mod types;

use serde::{Deserialize, Serialize};

pub use relay::RelayClient;

/// The public relay everyone starts on. Anyone can run their own (see the README) and set it in
/// Settings → Relay, or with the `TOKENBUD_RELAY` environment variable.
pub const DEFAULT_RELAY_URL: &str = "https://tokenbud-relay.hassen-ben-mbarek.workers.dev";

const APP_FILE: &str = "app.json";

/// Settings shared by host and client mode on this device.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct AppSettings {
    /// A relay of your own; empty = the default relay.
    relay_url: String,
}

/// The relay in use: `TOKENBUD_RELAY`, else the one saved in Settings, else the default.
pub fn relay_url() -> String {
    if let Some(env) = std::env::var("TOKENBUD_RELAY").ok().filter(|s| !s.trim().is_empty()) {
        return env.trim().trim_end_matches('/').to_string();
    }
    custom_relay().unwrap_or_else(|| DEFAULT_RELAY_URL.into())
}

/// The relay saved in Settings, if it isn't the default.
pub fn custom_relay() -> Option<String> {
    store::load_json::<AppSettings>(APP_FILE).ok().map(|s| s.relay_url).filter(|u| !u.trim().is_empty())
}

/// Save a relay of your own (`None` = back to the default).
pub fn set_custom_relay(url: Option<&str>) -> anyhow::Result<()> {
    let relay_url = url.map(|u| u.trim().trim_end_matches('/').to_string()).unwrap_or_default();
    let relay_url = if relay_url == DEFAULT_RELAY_URL { String::new() } else { relay_url };
    store::save_json(APP_FILE, &AppSettings { relay_url })
}

/// Is `TOKENBUD_RELAY` overriding the saved setting?
pub fn relay_from_env() -> bool {
    std::env::var("TOKENBUD_RELAY").is_ok_and(|s| !s.trim().is_empty())
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// This computer's user name, shown to the other side.
pub fn user_name() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Someone".into())
}
