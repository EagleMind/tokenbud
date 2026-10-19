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

/// Why a host paused sharing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PauseKind {
    /// The host's hourly reserve is used up.
    Limit,
    /// The host is using Claude Code themselves.
    Busy,
}

/// Why and until when a host paused sharing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Paused {
    pub kind: PauseKind,
    /// When sharing resumes on its own (for "limit"), in ms since the epoch.
    pub until: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    /// The role name chat APIs use.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
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
    Sessions {
        sessions: Vec<Session>,
    },
    Job {
        job_id: String,
        name: String,
        prompt: String,
        history: Vec<Turn>,
        #[serde(default)]
        context: Option<String>,
    },
    Cancel {
        job_id: String,
    },
}

/// How a prompt ended, as the host reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultStatus {
    Done,
    Error,
}

/// Messages the host sends up the WebSocket.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostToRelay {
    Config {
        password: String,
        seats: u32,
        name: String,
    },
    Kick {
        session_id: String,
    },
    /// Pause sharing (`paused: Some`) or resume it (`None`). Connected people stay connected.
    Pause {
        paused: Option<Paused>,
    },
    Result {
        job_id: String,
        status: ResultStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// These shapes are what relay/src/index.ts sends and expects.
    #[test]
    fn matches_the_relay_wire_format() {
        let job: RelayToHost = serde_json::from_value(json!({
            "type": "job", "job_id": "j_1", "session_id": "s_1", "name": "Sam",
            "prompt": "hi", "history": [{"role": "user", "content": "a"}], "context": null
        }))
        .unwrap();
        assert!(matches!(job, RelayToHost::Job { ref job_id, ref history, .. } if job_id == "j_1" && history.len() == 1));

        let result = serde_json::to_value(HostToRelay::Result {
            job_id: "j_1".into(),
            status: ResultStatus::Done,
            text: Some("ok".into()),
            error: None,
        })
        .unwrap();
        assert_eq!(result, json!({"type": "result", "job_id": "j_1", "status": "done", "text": "ok"}));

        let pause = serde_json::to_value(HostToRelay::Pause { paused: Some(Paused { kind: PauseKind::Limit, until: Some(5) }) }).unwrap();
        assert_eq!(pause, json!({"type": "pause", "paused": {"kind": "limit", "until": 5}}));

        let ping: PingResponse = serde_json::from_value(json!({"online": true, "paused": {"kind": "busy", "until": null}})).unwrap();
        assert_eq!(ping.paused.unwrap().kind, PauseKind::Busy);
    }
}
