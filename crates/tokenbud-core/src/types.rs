//! Wire types shared with the Cloudflare relay (`relay/src/index.ts`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct RegisterResponse {
    pub host_id: String,
    pub host_secret: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionResponse {
    pub session_token: String,
    pub host_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PingResponse {
    pub online: bool,
    /// Set while the host has paused sharing (its reserve kicked in).
    #[serde(default)]
    pub paused: Option<Paused>,
}

/// Why and until when a host paused sharing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Paused {
    /// "limit": the host's hourly reserve is used up; "busy": the host is using Claude Code themselves.
    pub kind: String,
    /// When sharing resumes on its own (for "limit"), in ms since the epoch.
    pub until: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// One message of the conversation so far.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Turn {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AskRequest {
    pub prompt: String,
    /// Earlier turns of this chat, oldest first, so the host's agent answers in context.
    pub history: Vec<Turn>,
    /// What the asker wants the agent to know about them (their saved memory), as a system prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JobView {
    pub job_id: String,
    pub status: JobStatus,
    pub text: Option<String>,
    pub error: Option<String>,
}

/// Someone connected to the host right now.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub since: i64,
    /// Waiting for an answer right now.
    pub busy: bool,
}

/// Messages the relay sends down the host WebSocket.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayToHost {
    Sessions { sessions: Vec<Session> },
    Job {
        job_id: String,
        session_id: String,
        name: String,
        prompt: String,
        history: Vec<Turn>,
        #[serde(default)]
        context: Option<String>,
    },
    Cancel { job_id: String },
}

/// Messages the host sends up the WebSocket.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostToRelay {
    Config { password: String, seats: u32, name: String },
    Kick { session_id: String },
    /// Pause sharing (`paused: Some`) or resume it (`None`). Connected people stay connected.
    Pause { paused: Option<Paused> },
    Result {
        job_id: String,
        /// "done" or "error"
        status: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}
