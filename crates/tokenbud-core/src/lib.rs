//! Shared pieces of tokenbud: wire types, the relay HTTP client, storage, and small helpers.

pub mod relay;
pub mod store;
pub mod text;
pub mod types;

use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

pub use relay::{RelayClient, RelayError};

/// The public relay everyone starts on. Anyone can run their own (see the README) and set it in
/// Settings → Relay, or with the `TOKENBUD_RELAY` environment variable.
pub const DEFAULT_RELAY_URL: &str = "https://tokenbud-relay.hassen-ben-mbarek.workers.dev";

const APP_FILE: &str = "app.json";

/// One HTTP client for the whole process, so connections are reused. Callers set per-request
/// timeouts with `RequestBuilder::timeout`.
pub fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("tokenbud/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("an HTTP client with default TLS settings")
    })
}

/// Where plain `http://` is acceptable. Anything carrying a secret should be https unless it
/// never leaves this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllowHttp {
    /// Only for this computer (localhost, 127.0.0.1, ::1).
    Loopback,
    /// Also for the local network (10/8, 172.16/12, 192.168/16, fc00::/7, *.local).
    LocalNetwork,
}

/// A base URL without a trailing slash. Adds `default_scheme://` when none is given, and refuses
/// plain http beyond what `allow_http` permits, so API keys and relay secrets aren't sent in the clear.
pub fn normalize_url(input: &str, default_scheme: &str, allow_http: AllowHttp) -> Result<String> {
    let s = input.trim().trim_end_matches('/');
    if s.is_empty() {
        bail!("Enter an address.");
    }
    let s = if s.contains("://") { s.to_string() } else { format!("{default_scheme}://{s}") };
    let Ok(url) = reqwest::Url::parse(&s) else { bail!("{s} isn't a valid address.") };
    let host = url.host_str().unwrap_or_default();
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(host) || (allow_http == AllowHttp::LocalNetwork && is_local_network(host)) => {}
        "http" => bail!("Use https:// for {host}. Plain http is only allowed for this computer or your local network."),
        other => bail!("{other}:// addresses aren't supported."),
    }
    Ok(s)
}

fn is_loopback(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost" || host.ends_with(".localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn is_local_network(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.ends_with(".local")
        || match host.parse::<IpAddr>() {
            Ok(IpAddr::V4(ip)) => ip.is_private() || ip.is_link_local(),
            Ok(IpAddr::V6(ip)) => (ip.segments()[0] & 0xfe00) == 0xfc00,
            Err(_) => false,
        }
}

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
pub fn set_custom_relay(url: Option<&str>) -> Result<()> {
    let relay_url = match url {
        Some(u) => normalize_url(u, "https", AllowHttp::Loopback)?,
        None => String::new(),
    };
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
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "Someone".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls() {
        assert_eq!(normalize_url("relay.example.dev/", "https", AllowHttp::Loopback).unwrap(), "https://relay.example.dev");
        assert_eq!(normalize_url("localhost:11434", "http", AllowHttp::Loopback).unwrap(), "http://localhost:11434");
        assert_eq!(normalize_url("http://[::1]:8787", "https", AllowHttp::Loopback).unwrap(), "http://[::1]:8787");
        assert!(normalize_url("http://api.example.com", "https", AllowHttp::LocalNetwork).is_err());
        assert!(normalize_url("http://192.168.1.20:1234", "https", AllowHttp::Loopback).is_err());
        assert!(normalize_url("http://192.168.1.20:1234", "https", AllowHttp::LocalNetwork).is_ok());
        assert!(normalize_url("gpu-box.local:11434", "http", AllowHttp::LocalNetwork).is_ok());
        assert!(normalize_url("ftp://x", "https", AllowHttp::Loopback).is_err());
        assert!(normalize_url("  ", "https", AllowHttp::Loopback).is_err());
    }
}
