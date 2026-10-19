//! Model providers. Almost everyone speaks the OpenAI-compatible chat API (OpenAI itself, Google,
//! Mistral, Groq, DeepSeek, xAI, OpenRouter, and local servers like Ollama and LM Studio), so one
//! client covers them. Anthropic has its own Messages API, handled here too.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};

use crate::engine::Job;
use tokenbud_core::text::{error_message, strip_tag};
use tokenbud_core::types::Role;
use tokenbud_core::{http, normalize_url, store, AllowHttp};

const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_MAX_TOKENS: u32 = 16000;
const ANTHROPIC_ATTEMPTS: u64 = 3;

/// How a provider is called.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PresetKind {
    /// Anthropic's own Messages API.
    Anthropic,
    /// The OpenAI-compatible chat API at a fixed address.
    OpenAiCompatible,
    /// The OpenAI-compatible chat API at an address you enter; the key is optional.
    Custom,
}

/// A cloud provider you can share through with your own API key.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    #[serde(skip)]
    pub kind: PresetKind,
    /// OpenAI-compatible base URL (empty for Anthropic and Custom).
    #[serde(skip)]
    pub base_url: &'static str,
    /// Where to get a key, shown next to the key field.
    pub key_url: &'static str,
    /// Used when you haven't picked one (empty = the first one the provider lists).
    pub default_model: &'static str,
}

const fn openai(id: &'static str, name: &'static str, base_url: &'static str, key_url: &'static str) -> Preset {
    Preset { id, name, kind: PresetKind::OpenAiCompatible, base_url, key_url, default_model: "" }
}

pub const PRESETS: &[Preset] = &[
    Preset {
        id: "anthropic",
        name: "Anthropic",
        kind: PresetKind::Anthropic,
        base_url: "",
        key_url: "platform.claude.com",
        default_model: "claude-opus-5-5",
    },
    openai("openai", "OpenAI", "https://api.openai.com/v1", "platform.openai.com/api-keys"),
    openai("google", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "aistudio.google.com/apikey"),
    openai("mistral", "Mistral", "https://api.mistral.ai/v1", "console.mistral.ai"),
    openai("groq", "Groq", "https://api.groq.com/openai/v1", "console.groq.com/keys"),
    openai("deepseek", "DeepSeek", "https://api.deepseek.com/v1", "platform.deepseek.com/api_keys"),
    openai("xai", "xAI", "https://api.x.ai/v1", "console.x.ai"),
    openai("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openrouter.ai/keys"),
    Preset { id: "custom", name: "Custom", kind: PresetKind::Custom, base_url: "", key_url: "", default_model: "" },
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

/// "localhost:11434", "http://localhost:11434" or ".../v1" all mean the same server. Plain http
/// is fine on this computer and the local network (a GPU box), never across the internet.
pub fn normalize(url: &str) -> Result<String> {
    let url = normalize_url(url, "http", AllowHttp::LocalNetwork)?;
    Ok(if url.ends_with("/v1") || url.ends_with("/openai") { url } else { format!("{url}/v1") })
}

/// Models that can't chat (embeddings, speech, images, moderation) are left out.
fn chat_capable(id: &str) -> bool {
    let id = id.to_lowercase();
    !["embed", "tts", "whisper", "dall-e", "moderation", "transcribe", "image", "audio", "realtime", "search"]
        .iter()
        .any(|w| id.contains(w))
}

pub async fn list_models(base_url: &str, key: Option<&str>) -> Result<Vec<String>> {
    let mut req = http().get(format!("{base_url}/models")).timeout(LIST_TIMEOUT);
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await?;
    let status = resp.status();
    if matches!(status.as_u16(), 401 | 403) {
        bail!("the key was refused");
    }
    if !status.is_success() {
        bail!("error {}", status.as_u16());
    }
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let mut names: Vec<String> = body["data"]
        .as_array()
        .map(|list| list.iter().filter_map(|m| m["id"].as_str().map(|s| s.trim_start_matches("models/").to_string())).collect())
        .unwrap_or_default();
    names.retain(|n| chat_capable(n));
    names.sort();
    names.dedup();
    Ok(names)
}

pub async fn chat(base_url: &str, key: Option<&str>, model: &str, job: &Job, timeout: Duration, who: &str) -> Result<String> {
    let mut messages = vec![];
    if let Some(context) = job.context.as_deref().filter(|c| !c.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": context }));
    }
    for t in job.history.iter().filter(|t| !t.content.trim().is_empty()) {
        messages.push(json!({ "role": t.role.as_str(), "content": t.content }));
    }
    messages.push(json!({ "role": "user", "content": job.prompt }));

    let mut req = http()
        .post(format!("{base_url}/chat/completions"))
        .timeout(timeout)
        .json(&json!({ "model": model, "messages": messages, "stream": false }));
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.with_context(|| format!("calling {who}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = error_message(&body).unwrap_or_else(|| "unknown error".into());
        bail!("{who} error {}: {msg}", status.as_u16());
    }
    // Reasoning models write their thinking in <think>…</think> first; people only want the answer.
    let text = strip_tag(body["choices"][0]["message"]["content"].as_str().unwrap_or_default(), "think");
    if text.is_empty() {
        bail!("{model} returned an empty answer");
    }
    Ok(text)
}

// ----- Anthropic -----

/// Earlier turns plus the new prompt, as Messages API messages (strictly alternating, user first).
fn anthropic_messages(job: &Job) -> Value {
    let mut merged: Vec<Value> = vec![];
    let turns = job.history.iter().map(|t| (t.role, t.content.as_str())).chain([(Role::User, job.prompt.as_str())]);
    for (role, content) in turns.filter(|(_, c)| !c.trim().is_empty()) {
        match merged.last_mut() {
            Some(last) if last["role"] == role.as_str() => {
                let joined = format!("{}\n\n{content}", last["content"].as_str().unwrap_or(""));
                last["content"] = json!(joined);
            }
            _ => merged.push(json!({ "role": role.as_str(), "content": content })),
        }
    }
    if merged.first().is_some_and(|m| m["role"] == "assistant") {
        merged.insert(0, json!({ "role": "user", "content": "(earlier conversation)" }));
    }
    Value::Array(merged)
}

pub async fn anthropic_models(key: &str) -> Result<Vec<String>> {
    let resp = http()
        .get(format!("{ANTHROPIC_URL}/models?limit=100"))
        .timeout(LIST_TIMEOUT)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await?;
    if matches!(resp.status().as_u16(), 401 | 403) {
        bail!("the key was refused");
    }
    let body: Value = resp.error_for_status()?.json().await?;
    Ok(body["data"].as_array().map(|l| l.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect()).unwrap_or_default())
}

pub async fn anthropic_chat(job: &Job, key: &str, model: &str, timeout: Duration) -> Result<String> {
    let mut body = json!({
        "model": model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "messages": anthropic_messages(job),
        "output_config": { "effort": "medium" },
    });
    if let Some(context) = job.context.as_deref().filter(|c| !c.trim().is_empty()) {
        body["system"] = json!(context);
    }
    let mut attempt = 0;
    let resp: Value = loop {
        attempt += 1;
        let r = http()
            .post(format!("{ANTHROPIC_URL}/messages"))
            .timeout(timeout)
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .context("calling the Anthropic API")?;
        let status = r.status();
        let text = r.text().await.unwrap_or_default();
        if status.is_success() {
            break serde_json::from_str(&text).context("parsing the Anthropic response")?;
        }
        // Rate limits and overload are worth a short wait and another try.
        let retryable = matches!(status.as_u16(), 429 | 529) || status.is_server_error();
        if retryable && attempt < ANTHROPIC_ATTEMPTS {
            tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
            continue;
        }
        let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| error_message(&v)).unwrap_or(text);
        bail!("Anthropic API error {}: {msg}", status.as_u16());
    };
    if resp["stop_reason"] == "refusal" {
        bail!("the model declined this request");
    }
    let text: String = resp["content"]
        .as_array()
        .map(|blocks| blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect())
        .unwrap_or_default();
    if text.trim().is_empty() {
        bail!("the model returned no text");
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
        let base_url = normalize(configured_url)?;
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

/// The model to use: the one you picked, else the provider's default, else the first one listed.
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
    use tokenbud_core::types::Turn;

    fn job(history: Vec<(Role, &str)>, prompt: &str) -> Job {
        Job {
            id: "j_1".into(),
            prompt: prompt.into(),
            history: history.into_iter().map(|(role, c)| Turn { role, content: c.into() }).collect(),
            context: None,
        }
    }

    #[test]
    fn normalizes_server_addresses() {
        assert_eq!(normalize("localhost:11434").unwrap(), "http://localhost:11434/v1");
        assert_eq!(normalize("http://10.0.0.5:1234/").unwrap(), "http://10.0.0.5:1234/v1");
        assert_eq!(normalize("https://h.example/v1").unwrap(), "https://h.example/v1");
        assert!(normalize("http://api.example.com").is_err(), "no keys over plain http across the internet");
    }

    #[test]
    fn filters_non_chat_models() {
        assert!(chat_capable("gpt-x"));
        assert!(!chat_capable("text-embedding-3-small"));
        assert!(!chat_capable("whisper-1"));
    }

    #[test]
    fn picks_models() {
        let listed = vec!["a".to_string(), "b".to_string()];
        assert_eq!(pick_model("b", "", &listed).unwrap(), "b");
        assert_eq!(pick_model("", "claude-x", &listed).unwrap(), "claude-x");
        assert_eq!(pick_model("", "", &listed).unwrap(), "a");
        assert!(pick_model("", "", &[]).is_err());
    }

    #[test]
    fn builds_alternating_anthropic_messages() {
        let m = anthropic_messages(&job(vec![(Role::User, "a"), (Role::User, "b"), (Role::Assistant, "c")], "d"));
        let roles: Vec<&str> = m.as_array().unwrap().iter().map(|x| x["role"].as_str().unwrap()).collect();
        assert_eq!(roles, ["user", "assistant", "user"]);
        assert_eq!(m[0]["content"], "a\n\nb");

        let m = anthropic_messages(&job(vec![(Role::Assistant, "hello")], "hi"));
        assert_eq!(m[0]["role"], "user", "must start with the user");
        assert_eq!(m.as_array().unwrap().len(), 3);
    }

    #[test]
    fn presets_are_consistent() {
        for p in PRESETS {
            match p.kind {
                PresetKind::OpenAiCompatible => assert!(p.base_url.starts_with("https://"), "{}", p.id),
                PresetKind::Anthropic | PresetKind::Custom => assert!(p.base_url.is_empty(), "{}", p.id),
            }
        }
        assert!(preset("openai").is_some() && preset("nope").is_none());
    }
}
