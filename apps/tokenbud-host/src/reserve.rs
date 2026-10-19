//! The host's reserve: how much it lends, and when it stops lending so the host never runs short.
//!
//! Two rules, both checked on this computer only:
//! - an hourly limit on answered prompts (rolling 60 minutes);
//! - pause while the host is using Claude Code themselves.

use std::collections::{BTreeSet, VecDeque};
use std::sync::Mutex;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tokenbud_core::now_ms;
use tokenbud_core::types::{PauseKind, Paused};

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// One answered prompt, and what it cost when the engine says (only Claude Code does).
#[derive(Debug, Clone, Copy)]
struct Lent {
    at: i64,
    cost_usd: Option<f64>,
}

/// Prompts answered for others in the last 24 hours.
#[derive(Debug, Default)]
pub struct Lending {
    entries: VecDeque<Lent>,
}

impl Lending {
    pub fn record(&mut self, cost_usd: Option<f64>) {
        self.entries.push_back(Lent { at: now_ms(), cost_usd });
        self.trim();
    }

    fn trim(&mut self) {
        let cutoff = now_ms() - DAY_MS;
        while self.entries.front().is_some_and(|e| e.at < cutoff) {
            self.entries.pop_front();
        }
    }

    pub fn last_hour(&self) -> u32 {
        let cutoff = now_ms() - HOUR_MS;
        self.entries.iter().filter(|e| e.at >= cutoff).count() as u32
    }

    pub fn last_day(&self) -> u32 {
        let cutoff = now_ms() - DAY_MS;
        self.entries.iter().filter(|e| e.at >= cutoff).count() as u32
    }

    pub fn cost_last_day(&self) -> f64 {
        let cutoff = now_ms() - DAY_MS;
        self.entries.iter().filter(|e| e.at >= cutoff).filter_map(|e| e.cost_usd).sum()
    }

    /// With an hourly limit of `max` (0 = none): paused until when, if at all.
    pub fn limit_reached(&self, max: u32) -> Option<i64> {
        if max == 0 {
            return None;
        }
        let cutoff = now_ms() - HOUR_MS;
        let recent: Vec<i64> = self.entries.iter().map(|e| e.at).filter(|at| *at >= cutoff).collect();
        if (recent.len() as u32) < max {
            return None;
        }
        // Lending resumes when enough of the hour's prompts have aged out to drop below the limit.
        let index = recent.len() - max as usize;
        Some(recent[index] + HOUR_MS)
    }
}

pub fn limit_pause(until: i64) -> Paused {
    Paused { kind: PauseKind::Limit, until: Some(until) }
}

pub fn busy_pause() -> Paused {
    Paused { kind: PauseKind::Busy, until: None }
}

/// Processes tokenbud started itself (prompts it is answering, engine checks): not "the host
/// using Claude".
static OWN_PIDS: Mutex<BTreeSet<u32>> = Mutex::new(BTreeSet::new());

/// A process tokenbud started. While it's alive the busy check ignores it. Dropped before
/// `finished()` (a cancelled or timed-out prompt), it ends the whole process tree: on Windows the
/// npm `claude.cmd` shim runs cmd.exe, which runs node, and killing only cmd.exe would leave node
/// answering a prompt nobody is waiting for.
pub struct OwnProcess {
    pid: Option<u32>,
    #[cfg_attr(not(windows), allow(dead_code))]
    done: bool,
}

impl OwnProcess {
    pub fn new(pid: Option<u32>) -> Self {
        if let Some(pid) = pid {
            OWN_PIDS.lock().unwrap_or_else(|e| e.into_inner()).insert(pid);
        }
        Self { pid, done: false }
    }

    /// The process exited normally; nothing left to kill.
    pub fn finished(mut self) {
        self.done = true;
    }
}

impl Drop for OwnProcess {
    fn drop(&mut self) {
        let Some(pid) = self.pid else { return };
        OWN_PIDS.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
        #[cfg(windows)]
        if !self.done {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .status();
        }
    }
}

/// Is Claude Code running on this computer for someone other than tokenbud?
/// Counts the `claude` executable, and Node running the npm package. Children of tokenbud's own
/// processes (the npm `claude.cmd` shim starts cmd.exe, which starts node) don't count.
pub fn claude_in_use(sys: &mut System) -> bool {
    // Only what's needed to recognise Claude Code: the executable and the command line.
    let what = ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet).with_cmd(UpdateKind::OnlyIfNotSet);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, what);
    let own: BTreeSet<u32> = OWN_PIDS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let started_by_us = |pid: Pid| {
        let mut current = Some(pid);
        for _ in 0..4 {
            let Some(p) = current else { return false };
            if own.contains(&p.as_u32()) {
                return true;
            }
            current = sys.process(p).and_then(|proc| proc.parent());
        }
        false
    };
    sys.processes().iter().any(|(pid, p)| is_claude_code(p) && !started_by_us(*pid))
}

/// Claude Code itself, not the Claude desktop app (whose process is also `Claude.exe` on Windows
/// and `Claude` on macOS, and runs all the time). The desktop app's own copies of Claude Code
/// (its Code tab) do count: that's you using Claude Code.
fn is_claude_code(p: &sysinfo::Process) -> bool {
    let name = p.name().to_string_lossy().to_lowercase();
    let exe = p.exe().map(|e| e.to_string_lossy().to_lowercase().replace('\\', "/")).unwrap_or_default();
    let desktop_app =
        exe.contains("/windowsapps/claude_") || exe.contains("/anthropicclaude/") || exe.contains("claude.app/contents/macos/");
    if desktop_app {
        return false;
    }
    let native = if cfg!(windows) { name == "claude.exe" } else { p.name().to_string_lossy() == "claude" };
    native || (name.starts_with("node") && p.cmd().iter().any(|a| a.to_string_lossy().contains("claude-code")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hourly_limit_resumes_when_old_prompts_age_out() {
        let mut l = Lending::default();
        assert_eq!(l.limit_reached(2), None);
        l.entries.push_back(Lent { at: now_ms() - 50 * 60 * 1000, cost_usd: Some(0.1) });
        l.entries.push_back(Lent { at: now_ms() - 10 * 60 * 1000, cost_usd: None });
        let until = l.limit_reached(2).expect("paused");
        // The older prompt leaves the hour in about 10 minutes.
        assert!((until - now_ms() - 10 * 60 * 1000).abs() < 2000);
        assert_eq!(l.limit_reached(3), None);
        assert_eq!(l.limit_reached(0), None);
        assert_eq!(l.last_day(), 2);
        assert!((l.cost_last_day() - 0.1).abs() < 1e-9);
    }
}
