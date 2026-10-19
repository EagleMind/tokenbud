//! Model providers. Almost everyone speaks the OpenAI-compatible chat API (OpenAI itself, Google,
//! Mistral, Groq, DeepSeek, xAI, OpenRouter, and local servers like Ollama and LM Studio), so one
//! client covers them. Anthropic gets its own native client in backend.rs.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};

use crate::backend::Job;
use tokenbud_core::store;
use tokenbud_core::types::Role;

/// A cloud provider you can share through with your own API key.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    /// OpenAI-compatible base URL (unused for Anthropic, which has its own API).
    #[serde(skip)]
    pub base_url: &'static str,
    /// Where to get a key, shown next to the key field.
    pub key_url: &'static str,
    /// Used when you haven't picked one (empty = pick from the list).
    pub default_model: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset { id: "anthropic", name: "Anthropic", base_url: "", key_url: "platform.claude.com", default_model: "claude-opus-5-5" },
    Preset { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", key_url: "platform.openai.com/api-keys", default_model: "" },
    Preset {
        id: "google",
        name: "Google Gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        key_url: "aistudio.google.com/apikey",
        default_model: "",
    },
    Preset { id: "mistral", name: "Mistral", base_url: "https://api.mistral.ai/v1", key_url: "console.mistral.ai", default_model: "" },
    Preset { id: "groq", name: "Groq", base_url: "https://api.groq.com/openai/v1", key_url: "console.groq.com/keys", default_model: "" },
    Preset { id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com/v1", key_url: "platform.deepseek.com/api_keys", default_model: "" },
    Preset { id: "xai", name: "xAI", base_url: "https://api.x.ai/v1", key_url: "console.x.ai", default_model: "" },
    Preset { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", key_url: "openrouter.ai/keys", default_model: "" },
    Preset { id: "custom", name: "Custom", base_url: "", key_url: "", default_model: "" },
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

// ----- keys: one per provider, in the OS keychain -----

/// Keys saved before tokenbud had several providers.
const LEGACY_ANTHROPIC_KEY: &str = "anthropic_api_key";

fn key_name(provider: &str) -> String {
    format!("api_key:{provider}")
}

pub fn get_key(provider: &str) -> Result<Option<String>> {
    if let Some(k) = store::get_secret(&key_name(provider))? {
        return Ok(Some(k));
    }
    if provider == "anthropic" {
        return store::get_secret(LEGACY_ANTHROPIC_KEY);
    }
    Ok(None)
}

pub fn set_key(provider: &str, key: &str) -> Result<()> {
    store::set_secret(&key_name(provider), key)
}

pub fn forget_key(provider: &str) -> Result<()> {
    store::delete_secret(&key_name(provider))?;
    if provider == "anthropic" {
        store::delete_secret(LEGACY_ANTHROPIC_KEY)?;
    }
    Ok(())
}

// ----- the OpenAI-compatible client -----

fn http(timeout: Duration) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().timeout(timeout).build()?)
}

/// "localhost:11434", "http://localhost:11434" or ".../v1" all mean the same server.
pub fn normalize(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    let url = if url.contains("://") { url.to_string() } else { format!("http://{url}") };
    if url.ends_with("/v1") || url.ends_with("/openai") {
        url
    } else {
        format!("{url}/v1")
    }
}

/// Models that can't chat (embeddings, speech, images, moderation) are left out.
fn chat_capable(id: &str) -> bool {
    let id = id.to_lowercase();
    !["embed", "tts", "whisper", "dall-e", "moderation", "transcribe", "image", "audio", "realtime", "search"]
        .iter()
        .any(|w| id.contains(w))
}

pub async fn list_models(base_url: &str, key: Option<&str>) -> Result<Vec<String>> {
    let mut req = http(Duration::from_secs(10))?.get(format!("{base_url}/models"));
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.as_u16() == 401 || status.as_u16() == 403 {
        bail!("the key was refused");
    }
    if !status.is_success() {
        bail!("error {}", status.as_u16());
    }
    let mut names: Vec<String> = body["data"]
        .as_array()
        .map(|list| list.iter().filter_map(|m| m["id"].as_str().map(|s| s.trim_start_matches("models/").to_string())).collect())
        .unwrap_or_default();
    names.retain(|n| chat_capable(n));
    names.sort();
    names.dedup();
    Ok(names)
}

/// Reasoning models write their thinking in <think>...</think> before the answer; people only want the answer.
fn strip_thinking(text: &str) -> String {
    let mut out = text.to_string();
    while let Some(start) = out.find("<think>") {
        match out[start..].find("</think>") {
            Some(end) => out.replace_range(start..start + end + "</think>".len(), ""),
            None => out.truncate(start),
        }
    }
    out.trim().to_string()
}

pub async fn chat(base_url: &str, key: Option<&str>, model: &str, job: &Job, timeout: Duration, who: &str) -> Result<String> {
    let mut messages = vec![];
    if let Some(context) = job.context.as_deref().filter(|c| !c.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": context }));
    }
    for t in job.history.iter().filter(|t| !t.content.trim().is_empty()) {
        messages.push(json!({ "role": if t.role == Role::User { "user" } else { "assistant" }, "content": t.content }));
    }
    messages.push(json!({ "role": "user", "content": job.prompt }));

    let mut req = http(timeout)?
        .post(format!("{base_url}/chat/completions"))
        .json(&json!({ "model": model, "messages": messages, "stream": false }));
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.with_context(|| format!("calling {who}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = body["error"]["message"].as_str().or(body["error"].as_str()).unwrap_or("unknown error");
        bail!("{who} error {}: {msg}", status.as_u16());
    }
    let text = strip_thinking(body["choices"][0]["message"]["content"].as_str().unwrap_or_default());
    if text.is_empty() {
        bail!("{model} returned an empty answer");
    }
    Ok(text)
}

// ----- local servers -----

/// Where the usual apps listen. Checked in order when no address is set.
const KNOWN_SERVERS: &[(&str, &str)] = &[("Ollama", "http://127.0.0.1:11434/v1"), ("LM Studio", "http://127.0.0.1:1234/v1")];

/// A local model server that answered.
pub struct Server {
    /// e.g. "Ollama", or the address when it isn't one of the known ones.
    pub name: String,
    pub base_url: String,
    pub models: Vec<String>,
}

/// The configured server, or the first known one that's running.
pub async fn find_local(configured_url: &str) -> Result<Server> {
    if !configured_url.trim().is_empty() {
        let base_url = normalize(configured_url);
        let models = list_models(&base_url, None).await.with_context(|| format!("No model server answered at {base_url}"))?;
        return Ok(Server { name: base_url.clone(), base_url, models });
    }
    for (name, base_url) in KNOWN_SERVERS {
        if let Ok(models) = list_models(base_url, None).await {
            return Ok(Server { name: (*name).into(), base_url: (*base_url).into(), models });
        }
    }
    bail!("No local model found. Start Ollama or LM Studio, or enter its address.")
}

/// The model to use: the one you picked, or the provider's default, or the first one listed.
pub fn pick_model(chosen: &str, default: &str, available: &[String]) -> Result<String> {
    match (chosen.trim(), default) {
        ("", "") => available.first().cloned().ok_or_else(|| anyhow!("no models available")),
        ("", d) => Ok(d.to_string()),
        (c, _) => Ok(c.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_addresses() {
        assert_eq!(normalize("localhost:11434"), "http://localhost:11434/v1");
        assert_eq!(normalize("http://10.0.0.5:1234/"), "http://10.0.0.5:1234/v1");
        assert_eq!(normalize("http://h:1/v1"), "http://h:1/v1");
    }

    #[test]
    fn strips_thinking() {
        assert_eq!(strip_thinking("<think>hmm</think>\nHello"), "Hello");
        assert_eq!(strip_thinking("Hi <think>unfinished"), "Hi");
    }

    #[test]
    fn filters_non_chat_models() {
        assert!(chat_capable("gpt-x"));
        assert!(!chat_capable("text-embedding-3-small"));
        assert!(!chat_capable("whisper-1"));
    }
}
