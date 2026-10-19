//! The Claude Code engine: `claude -p` on your own login. Development builds only (see
//! `config::claude_code_allowed`): Anthropic's terms don't allow answering other people's prompts
//! with a Claude subscription.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::engine::{valid_job_id, Answer, Job};
use crate::reserve::OwnProcess;
use tokenbud_core::store;
use tokenbud_core::text::preview;

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Environment variables Claude Code needs to find its login, config and network. Everything else
/// (tokens and secrets in your shell, for instance) stays out of a stranger's prompt.
const PASSED_ENV: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "USERNAME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "SHELL",
    "TERM",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
];

/// Find the `claude` executable: on PATH or in the usual install folders (including the npm
/// `claude.cmd` shim on Windows), or else the newest copy the Claude desktop app keeps for itself.
/// The desktop app's copies live in versioned folders that each update replaces, so we look
/// again every time instead of saving a path.
fn resolve_claude() -> Result<PathBuf> {
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
    cmd.env_clear();
    for name in PASSED_ENV {
        if let Some(v) = std::env::var_os(name) {
            cmd.env(name, v);
        }
    }
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
        let tag = t.role.as_str();
        out.push_str(&format!("<{tag}>\n{}\n</{tag}>\n", t.content.trim()));
    }
    out.push_str("</conversation>\n\nReply to this new message, taking the conversation above into account:\n\n");
    out.push_str(&job.prompt);
    out
}

pub async fn answer(job: &Job) -> Result<Answer> {
    // The ID becomes a folder name below; the service checks it too, this keeps the engine safe alone.
    if !valid_job_id(&job.id) {
        bail!("invalid job id");
    }
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
        // Ours, so the reserve doesn't pause for it; dropped (also on cancel) it ends the whole tree.
        let own = OwnProcess::new(child.id());
        // The prompt goes in on stdin: no command-line length limits or quoting problems.
        let mut stdin = child.stdin.take().expect("stdin is piped");
        stdin.write_all(transcript(job).as_bytes()).await?;
        drop(stdin);
        let out = child.wait_with_output().await?;
        own.finished();
        parse_cli_output(&out.stdout, &out.stderr, out.status.success())
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
        bail!("claude failed: {}", preview(&msg, 500));
    }
    match stdout.trim() {
        "" => bail!("claude returned no output"),
        text => Ok(Answer { text: text.to_string(), cost_usd: None }),
    }
}

/// Is Claude Code installed and signed in?
pub async fn check() -> Result<String> {
    let run = |args: &'static [&'static str]| async move {
        let mut cmd = command()?;
        cmd.args(args).stdin(Stdio::null());
        let child = cmd.spawn()?;
        let own = OwnProcess::new(child.id());
        let out = tokio::time::timeout(CHECK_TIMEOUT, child.wait_with_output()).await;
        let out = out.map_err(|_| anyhow!("claude didn't respond"))??;
        own.finished();
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokenbud_core::types::{Role, Turn};

    #[test]
    fn parses_cli_results() {
        let ok = br#"{"type":"result","is_error":false,"result":"hi there","total_cost_usd":0.01}"#;
        let a = parse_cli_output(ok, b"", true).unwrap();
        assert_eq!(a.text, "hi there");
        assert_eq!(a.cost_usd, Some(0.01));

        let err = br#"{"type":"result","is_error":true,"subtype":"error_max_turns","result":""}"#;
        assert!(parse_cli_output(err, b"", true).unwrap_err().to_string().contains("error_max_turns"));
        assert!(parse_cli_output(b"", b"boom", false).unwrap_err().to_string().contains("boom"));
        assert_eq!(parse_cli_output(b"plain text\n", b"", true).unwrap().text, "plain text");
    }

    #[test]
    fn transcript_puts_memory_first_and_history_in_order() {
        let job = Job {
            id: "j_1".into(),
            prompt: "and now?".into(),
            history: vec![Turn { role: Role::User, content: "q".into() }, Turn { role: Role::Assistant, content: "a".into() }],
            context: Some("Writes Go".into()),
        };
        let t = transcript(&job);
        assert!(t.starts_with("<about_the_person_asking>\nWrites Go"));
        assert!(t.find("<user>\nq").unwrap() < t.find("<assistant>\na").unwrap());
        assert!(t.ends_with("and now?"));
    }
}
