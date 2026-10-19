//! The connecting side of tokenbud: a seat on someone's host, opened with its ID and password,
//! plus the local-first memory that travels with each prompt.

pub mod mcp;
pub mod memory;

use anyhow::{anyhow, Result};
use tokenbud_core::types::{AskRequest, JobStatus, PingResponse, Turn};
use tokenbud_core::{relay_url, user_name, RelayClient};

/// "418 203 977", "418-203-977" or "418203977" -> "418203977".
pub fn normalize_id(id: &str) -> Result<String> {
    let digits: String = id.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    if digits.len() == 9 && digits.chars().all(|c| c.is_ascii_digit()) {
        Ok(digits)
    } else {
        Err(anyhow!("An ID is 9 digits, like 418 203 977."))
    }
}

/// A seat on someone's host: what opening a session with their ID and password gives you.
#[derive(Clone)]
pub struct Seat {
    pub relay: RelayClient,
    pub host_id: String,
    pub host_name: String,
    token: String,
}

impl Seat {
    pub async fn open(id: &str, password: &str) -> Result<Self> {
        let host_id = normalize_id(id)?;
        let relay = RelayClient::new(&relay_url())?;
        let r = relay.open_session(&host_id, password.trim(), &user_name()).await?;
        Ok(Self { relay, host_id, host_name: r.host_name, token: r.session_token })
    }

    /// Ask and wait for the answer text.
    pub async fn ask(&self, prompt: &str, history: Vec<Turn>, context: Option<String>) -> Result<String> {
        let req = AskRequest { prompt: prompt.to_string(), history, context };
        let job = self.relay.ask(&self.host_id, &self.token, &req).await?;
        match (job.status, job.text, job.error) {
            (JobStatus::Done, Some(text), _) => Ok(text),
            (_, _, Some(e)) => Err(anyhow!(e)),
            _ => Err(anyhow!("no answer")),
        }
    }

    /// Keeps the seat, and says whether the host is online and whether it paused sharing.
    pub async fn ping(&self) -> Result<PingResponse> {
        self.relay.ping(&self.host_id, &self.token).await
    }

    /// Give the seat back. Best effort: if the relay can't be reached it frees the seat itself soon after.
    pub async fn close(&self) {
        let _ = self.relay.close_session(&self.host_id, &self.token).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_ids() {
        assert_eq!(normalize_id("418 203 977").unwrap(), "418203977");
        assert_eq!(normalize_id("418-203-977").unwrap(), "418203977");
        assert!(normalize_id("41820397").is_err());
        assert!(normalize_id("41820397a").is_err());
    }
}
