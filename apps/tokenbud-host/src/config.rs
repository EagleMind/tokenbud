//! Host settings (`host.json`) and secrets.

use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tokenbud_core::{relay_url, store, DEFAULT_RELAY_URL};

pub const CONFIG_FILE: &str = "host.json";
const PASSWORD_SECRET: &str = "host_password";
pub const MAX_SEATS: u32 = 50;
/// The most prompts an hour the reserve can be set to lend.
pub const MAX_PER_HOUR: u32 = 1000;

/// What answers prompts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    /// A cloud provider (Anthropic, OpenAI, Google, ...) with your own API key; see `provider`.
    #[serde(alias = "api_key")]
    Provider,
    /// `claude -p` with your own Claude Code login. Development builds only: Anthropic's terms
    /// don't allow answering other people's prompts with a Claude subscription.
    ClaudeCode,
    /// A model running on this computer (Ollama, LM Studio, ...). (Unknown values load as this.)
    #[serde(other)]
    Local,
}

impl Engine {
    /// Is this engine available in this build?
    pub fn allowed(self) -> bool {
        self != Engine::ClaudeCode || claude_code_allowed()
    }
}

/// The Claude Code engine exists only in debug builds (`cargo run`, `npm run app`), for testing
/// on your own machine. Release builds, the ones you give to others, leave it out.
pub fn claude_code_allowed() -> bool {
    cfg!(debug_assertions)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct HostConfig {
    /// Your 9-digit ID on the default relay, assigned the first time you share.
    pub host_id: Option<String>,
    /// Your ID on each relay of your own (relay URL -> ID). Each relay hands out its own IDs.
    pub relay_hosts: BTreeMap<String, String>,
    pub engine: Engine,
    /// How many people can be connected and prompting at the same time.
    pub seats: u32,
    /// The reserve: lend at most this many prompts per rolling hour (0 = no limit).
    pub max_per_hour: u32,
    /// The reserve: pause sharing while you're using Claude Code yourself.
    pub pause_while_busy: bool,
    /// Address of a local model server; empty finds Ollama or LM Studio on their usual ports.
    pub local_url: String,
    /// Which local model answers; empty uses the first one the server lists.
    pub local_model: String,
    /// Which cloud provider answers when `engine` is `Provider` (an id from `providers::PRESETS`).
    pub provider: String,
    /// The model picked for each provider, so switching back keeps your choice.
    pub provider_models: BTreeMap<String, String>,
    /// Base URL of the "custom" provider (any OpenAI-compatible API).
    pub custom_url: String,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            host_id: None,
            relay_hosts: BTreeMap::new(),
            engine: Engine::Local,
            seats: 3,
            max_per_hour: 30,
            pause_while_busy: true,
            local_url: String::new(),
            local_model: String::new(),
            provider: "anthropic".into(),
            provider_models: BTreeMap::new(),
            custom_url: String::new(),
        }
    }
}

impl HostConfig {
    pub fn load() -> Result<Self> {
        store::load_json(CONFIG_FILE)
    }

    pub fn save(&self) -> Result<()> {
        store::save_json(CONFIG_FILE, self)
    }

    /// The engine actually used: a saved Claude Code choice falls back to local models in release builds.
    pub fn engine(&self) -> Engine {
        if self.engine.allowed() {
            self.engine
        } else {
            Engine::Local
        }
    }

    /// The model chosen for a provider ("" = the provider's default, or the first it lists).
    pub fn provider_model(&self, provider: &str) -> String {
        self.provider_models.get(provider).cloned().unwrap_or_default()
    }

    /// Your ID on a relay, if you've shared through it before.
    pub fn host_id_on(&self, relay: &str) -> Option<String> {
        if relay == DEFAULT_RELAY_URL {
            self.host_id.clone()
        } else {
            self.relay_hosts.get(relay).cloned()
        }
    }

    pub fn set_host_id_on(&mut self, relay: &str, id: String) {
        if relay == DEFAULT_RELAY_URL {
            self.host_id = Some(id);
        } else {
            self.relay_hosts.insert(relay.to_string(), id);
        }
    }

    /// Forget your ID on a relay (it no longer knows it); the next connection registers a new one.
    pub fn forget_host_id_on(&mut self, relay: &str) {
        if relay == DEFAULT_RELAY_URL {
            self.host_id = None;
        } else {
            self.relay_hosts.remove(relay);
        }
    }

    /// Your ID on the relay in use right now.
    pub fn current_host_id(&self) -> Option<String> {
        self.host_id_on(&relay_url())
    }

    pub fn host_secret_on(&self, relay: &str) -> Result<Option<String>> {
        match self.host_id_on(relay) {
            Some(id) => store::get_secret(&host_secret_key(relay, &id)),
            None => Ok(None),
        }
    }
}

/// Keychain name of the secret the host app signs in to a relay with.
pub fn host_secret_key(relay: &str, host_id: &str) -> String {
    if relay == DEFAULT_RELAY_URL {
        format!("host_secret:{host_id}")
    } else {
        format!("host_secret:{relay}#{host_id}")
    }
}

/// The current password, made on first use.
pub fn password() -> Result<String> {
    match store::get_secret(PASSWORD_SECRET)? {
        Some(p) => Ok(p),
        None => new_password(),
    }
}

/// Replace the password with a fresh random one.
pub fn new_password() -> Result<String> {
    // No 0/o, 1/l/i: easy to read out loud.
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| anyhow!("no randomness available: {e}"))?;
    let p: String = bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
    store::set_secret(PASSWORD_SECRET, &p)?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_one_id_per_relay() {
        let mut cfg = HostConfig { host_id: Some("111111111".into()), ..Default::default() };
        cfg.set_host_id_on("https://mine.example", "222222222".into());
        assert_eq!(cfg.host_id_on(DEFAULT_RELAY_URL).as_deref(), Some("111111111"));
        assert_eq!(cfg.host_id_on("https://mine.example").as_deref(), Some("222222222"));
        cfg.forget_host_id_on("https://mine.example");
        assert_eq!(cfg.host_id_on("https://mine.example"), None);
        assert_eq!(cfg.host_id_on(DEFAULT_RELAY_URL).as_deref(), Some("111111111"));
        // Secrets of different relays never share a keychain entry.
        assert_ne!(host_secret_key(DEFAULT_RELAY_URL, "1"), host_secret_key("https://mine.example", "1"));
    }

    #[test]
    fn reads_old_engine_names() {
        let cfg: HostConfig = serde_json::from_str(r#"{"engine":"api_key"}"#).unwrap();
        assert_eq!(cfg.engine, Engine::Provider);
        let cfg: HostConfig = serde_json::from_str(r#"{"engine":"something_new"}"#).unwrap();
        assert_eq!(cfg.engine, Engine::Local);
    }
}
