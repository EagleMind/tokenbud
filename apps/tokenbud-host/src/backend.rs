//! What actually answers a prompt: a local model, a cloud provider with your own key (Anthropic,
//! OpenAI, Google, ...), or (in development builds only) your own Claude Code.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::config::{Engine, HostConfig};
use crate::providers::{self, Preset};
use crate::reserve::{track_own, untrack_own};
use tokenbud_core::store;
use tokenbud_core::types::{Role, Turn};

const TIMEOUT: Duration = Duration::from_secs(600);
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1";
const API_MAX_TOKENS: u32 = 16000;

/// A prompt to answer, with the chat so far.
pub struct Job {
    pub id: String,
    pub prompt: String,
    pub history: Vec<Turn>,
    /// The asker's saved memory, sent as a system prompt.
    pub context: Option<String>,
}

/// What answered, plus Claude Code's cost estimate when it gives one.
pub struct Answer {
    pub text: String,
    pub cost_usd: Option<f64>,
}

pub async fn answer(cfg: &HostConfig, job: &Job) -> Result<Answer> {
    let fut = async {
        match cfg.engine() {
            Engine::Local => {
                let server = providers::find_local(&cfg.local_url).await?;
                let model = providers::pick_model(&cfg.local_model, "", &server.models)
                    .map_err(|_| anyhow!("{} has no models yet. Download one first.", server.name))?;
                let text = providers::chat(&server.base_url, None, &model, job, TIMEOUT, &server.name).await?;
                Ok(Answer { text, cost_usd: None })
            }
            Engine::Provider => {
                let (preset, base_url, key) = provider_setup(cfg)?;
                // No pick and no default: the first model the provider lists, as Settings says.
                let model = match providers::pick_model(&cfg.provider_model(preset.id), preset.default_model, &[]) {
                    Ok(m) => m,
                    Err(_) => {
                        let listed = provider_models(cfg).await?;
                        providers::pick_model("", "", &listed).map_err(|_| anyhow!("Pick a {} model in Settings.", preset.name))?
                    }
                };
                let text = if preset.id == "anthropic" {
                    anthropic(job, key.as_deref().unwrap_or_default(), &model).await?
                } else {
                    providers::chat(&base_url, key.as_deref(), &model, job, TIMEOUT, preset.name).await?
                };
                Ok(Answer { text, cost_usd: None })
            }
            Engine::ClaudeCode => claude_code(job).await,
        }
    };
    tokio::time::timeout(TIMEOUT, fut).await.map_err(|_| anyhow!("no answer after {} minutes", TIMEOUT.as_secs() / 60))?
}

// ---------- Anthropic Messages API ----------

/// Earlier turns plus the new prompt, as Messages API messages (strictly alternating, user first).
fn api_messages(job: &Job) -> Value {
    let mut merged: Vec<Value> = vec![];
    let turns = job.history.iter().map(|t| (t.role, t.content.as_str())).chain([(Role::User, job.prompt.as_str())]);
    for (role, content) in turns.filter(|(_, c)| !c.trim().is_empty()) {
        let role = if role == Role::User { "user" } else { "assistant" };
        match merged.last_mut() {
            Some(last) if last["role"] == role => {
                let joined = format!("{}\n\n{content}", last["content"].as_str().unwrap_or(""));
                last["content"] = json!(joined);
            }
            _ => merged.push(json!({ "role": role, "content": content })),
        }
    }
    if merged.first().is_some_and(|m| m["role"] == "assistant") {
        merged.insert(0, json!({ "role": "user", "content": "(earlier conversation)" }));
    }
    Value::Array(merged)
}

/// The chosen provider, its API address, and your key for it.
fn provider_setup(cfg: &HostConfig) -> Result<(&'static Preset, String, Option<String>)> {
    let preset = providers::preset(&cfg.provider).ok_or_else(|| anyhow!("Pick a provider in Settings."))?;
    let base_url = if preset.id == "custom" {
        if cfg.custom_url.trim().is_empty() {
            bail!("Enter the address of your OpenAI-compatible API in Settings.");
        }
        providers::normalize(&cfg.custom_url)
    } else {
        preset.base_url.to_string()
    };
    let key = providers::get_key(preset.id)?;
    if key.is_none() && preset.id != "custom" {
        bail!("Add your {} API key in Settings.", preset.name);
    }
    Ok((preset, base_url, key))
}

/// The models a provider offers you (Anthropic's own API, or the OpenAI-compatible list).
pub async fn provider_models(cfg: &HostConfig) -> Result<Vec<String>> {
    let (preset, base_url, key) = provider_setup(cfg)?;
    if preset.id != "anthropic" {
        return providers::list_models(&base_url, key.as_deref()).await;
    }
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?
        .get(format!("{ANTHROPIC_URL}/models?limit=100"))
        .header("x-api-key", key.unwrap_or_default())
        .header("anthropic-version", "2023-06-01")
        .send()
        .await?;
    if matches!(resp.status().as_u16(), 401 | 403) {
        bail!("the key was refused");
    }
    let body: Value = resp.error_for_status()?.json().await?;
    Ok(body["data"]
        .as_array()
        .map(|l| l.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default())
}

async fn anthropic(job: &Job, key: &str, model: &str) -> Result<String> {
    let mut body = json!({
        "model": model,
        "max_tokens": API_MAX_TOKENS,
        "messages": api_messages(job),
        "output_config": { "effort": "medium" },
    });
    if let Some(context) = job.context.as_deref().filter(|c| !c.trim().is_empty()) {
        body["system"] = json!(context);
    }
    let http = reqwest::Client::builder().timeout(TIMEOUT).build()?;
    let mut attempt = 0;
    let resp: Value = loop {
        attempt += 1;
        let r = http
            .post(format!("{ANTHROPIC_URL}/messages"))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .context("calling the Anthropic API")?;
        let status = r.status();
        let text = r.text().await.unwrap_or_default();
        if status.is_success() {
            break serde_json::from_str(&text).context("parsing the Anthropic response")?;
        }
        let retryable = matches!(status.as_u16(), 429 | 529) || status.is_server_error();
        if retryable && attempt < 3 {
            tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
            continue;
        }
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or(text);
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

// ---------- Claude Code ----------

/// Find the `claude` executable: on PATH or in the usual install folders (including the npm
/// `claude.cmd` shim on Windows), or else the newest copy the Claude desktop app keeps for itself.
/// The desktop app's copies live in versioned folders that each update replaces, so we look
/// again every time instead of saving a path.
pub fn resolve_claude() -> Result<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd", "claude.bat"] } else { &["claude"] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        dirs.push(PathBuf::from(&home).join(".local").join("bin"));
        dirs.push(PathBuf::from(&home).join(".claude").join("local"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    for dir in dirs.iter().filter(|d| !is_desktop_app_path(d)) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    desktop_app_copy().ok_or_else(|| {
        anyhow!("Claude Code isn't installed. Install it from https://code.claude.com and sign in, or use an API key instead.")
    })
}

/// Folders where the Claude desktop app keeps its copies of Claude Code, one subfolder per version.
/// On Windows the app is an MSIX package: other programs find its files under
/// `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`.
fn desktop_app_roots() -> Vec<PathBuf> {
    let mut roots = vec![];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Claude").join("claude-code"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        if let Ok(packages) = std::fs::read_dir(PathBuf::from(local).join("Packages")) {
            for pkg in packages.flatten() {
                if pkg.file_name().to_string_lossy().starts_with("Claude_") {
                    roots.push(pkg.path().join("LocalCache").join("Roaming").join("Claude").join("claude-code"));
                }
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Library").join("Application Support").join("Claude").join("claude-code"));
    }
    roots
}

fn is_desktop_app_path(p: &Path) -> bool {
    p.to_string_lossy().to_lowercase().replace('\\', "/").contains("/claude/claude-code/")
}

/// The newest copy of Claude Code the Claude desktop app has right now, if any.
fn desktop_app_copy() -> Option<PathBuf> {
    let exe_name = if cfg!(windows) { "claude.exe" } else { "claude" };
    let mut best: Option<(Vec<u64>, std::time::SystemTime, PathBuf)> = None;
    for root in desktop_app_roots() {
        let Ok(versions) = std::fs::read_dir(&root) else { continue };
        for v in versions.flatten() {
            let version: Vec<u64> = v.file_name().to_string_lossy().split('.').map(|p| p.parse().unwrap_or(0)).collect();
            let Ok(builds) = std::fs::read_dir(v.path()) else { continue };
            for b in builds.flatten() {
                let exe = b.path().join(exe_name);
                let Ok(meta) = exe.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                if best.as_ref().is_none_or(|(bv, bm, _)| (&version, modified) > (bv, *bm)) {
                    best = Some((version.clone(), modified, exe));
                }
            }
        }
    }
    best.map(|(_, _, p)| p)
}

fn command() -> Result<Command> {
    let mut cmd = Command::new(resolve_claude()?);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up from the GUI app
    Ok(cmd)
}

/// The whole chat as one prompt (the CLI takes a single message), with the asker's memory first.
/// It all goes in on stdin: Windows can't pass a multi-line argument to the npm `claude.cmd` shim.
fn transcript(job: &Job) -> String {
    let mut out = match job.context.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(context) => format!("<about_the_person_asking>\n{}\n</about_the_person_asking>\n\n", context.trim()),
        None => String::new(),
    };
    if job.history.is_empty() {
        out.push_str(&job.prompt);
        return out;
    }
    out.push_str("This continues an earlier conversation. Everything said so far, oldest first:\n\n<conversation>\n");
    for t in &job.history {
        let tag = if t.role == Role::User { "user" } else { "assistant" };
        out.push_str(&format!("<{tag}>\n{}\n</{tag}>\n", t.content.trim()));
    }
    out.push_str("</conversation>\n\nReply to this new message, taking the conversation above into account:\n\n");
    out.push_str(&job.prompt);
    out
}

async fn claude_code(job: &Job) -> Result<Answer> {
    let mut cmd = command()?;
    // Each prompt runs in its own empty folder with no tools, so it can't see your files.
    let dir = store::data_dir()?.join("sandbox").join(&job.id);
    tokio::fs::create_dir_all(&dir).await?;
    cmd.current_dir(&dir).args([
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disallowedTools",
        "mcp__*",
        "--max-turns",
        "10",
    ]);
    let result = async {
        let mut child = cmd.spawn().context("starting claude")?;
        // Not the host using Claude Code: the reserve mustn't pause because of our own prompts.
        let pid = child.id();
        track_own(pid);
        let result = async {
            // The prompt goes in on stdin: no command-line length limits or quoting problems.
            let mut stdin = child.stdin.take().expect("stdin is piped");
            stdin.write_all(transcript(job).as_bytes()).await?;
            drop(stdin);
            let out = child.wait_with_output().await?;
            parse_cli_output(&out.stdout, &out.stderr, out.status.success())
        }
        .await;
        untrack_own(pid);
        result
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    result
}

fn parse_cli_output(stdout: &[u8], stderr: &[u8], success: bool) -> Result<Answer> {
    let stdout = String::from_utf8_lossy(stdout);
    // `--output-format json` prints one result object: {type, subtype, is_error, result, ...}
    if let Some(v) = stdout.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok()) {
        let text = v["result"].as_str().unwrap_or_default().trim().to_string();
        if v["is_error"].as_bool().unwrap_or(false) || !success {
            bail!("claude: {}", if text.is_empty() { v["subtype"].as_str().unwrap_or("unknown error") } else { &text });
        }
        if text.is_empty() {
            bail!("claude returned an empty answer");
        }
        return Ok(Answer { text, cost_usd: v["total_cost_usd"].as_f64() });
    }
    if !success {
        let stderr = String::from_utf8_lossy(stderr);
        let msg = if stderr.trim().is_empty() { stdout.trim().to_string() } else { stderr.trim().to_string() };
        bail!("claude failed: {}", msg.chars().take(500).collect::<String>());
    }
    match stdout.trim() {
        "" => bail!("claude returned no output"),
        text => Ok(Answer { text: text.to_string(), cost_usd: None }),
    }
}

/// Is the engine ready? Ok(description) or Err(what to do about it).
pub async fn check(cfg: &HostConfig) -> Result<String> {
    match cfg.engine() {
        Engine::Provider => {
            let (preset, _, _) = provider_setup(cfg)?;
            let models = provider_models(cfg).await.map_err(|e| anyhow!("{} didn't accept the request: {e:#}", preset.name))?;
            match providers::pick_model(&cfg.provider_model(preset.id), preset.default_model, &models) {
                Ok(m) => Ok(format!("{} is ready, answering with {m}.", preset.name)),
                Err(_) => bail!("{} has no models available for this key.", preset.name),
            }
        }
        Engine::Local => {
            let server = providers::find_local(&cfg.local_url).await?;
            let model = match cfg.local_model.trim() {
                "" => server.models.first().cloned(),
                m => Some(m.to_string()),
            };
            match model {
                Some(m) if server.models.iter().any(|x| x == &m) => Ok(format!("{} is running, answering with {m}.", server.name)),
                Some(m) => bail!("{} is running, but has no model called {m}.", server.name),
                None => bail!("{} is running, but has no models yet. Download one first.", server.name),
            }
        }
        Engine::ClaudeCode => {
            let run = |args: &'static [&'static str]| async move {
                let mut cmd = command()?;
                cmd.args(args).stdin(Stdio::null());
                let child = cmd.spawn()?;
                let pid = child.id();
                track_own(pid);
                let out = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output()).await;
                untrack_own(pid);
                let out = out.map_err(|_| anyhow!("claude didn't respond"))??;
                Ok::<_, anyhow::Error>((out.status.success(), String::from_utf8_lossy(&out.stdout).trim().to_string()))
            };
            let (_, version) = run(&["--version"]).await?;
            let (signed_in, status) = run(&["auth", "status"]).await?;
            let method = serde_json::from_str::<Value>(&status).ok().and_then(|v| v["authMethod"].as_str().map(str::to_string));
            let version = version.split_whitespace().next().unwrap_or("").to_string();
            match method.as_deref() {
                Some("none") => bail!("Claude Code {version} isn't signed in. Run `claude auth login`, then check again."),
                None if !signed_in => bail!("Claude Code {version} isn't signed in. Run `claude auth login`, then check again."),
                _ => Ok(format!("Claude Code {version}, signed in.")),
            }
        }
    }
}
