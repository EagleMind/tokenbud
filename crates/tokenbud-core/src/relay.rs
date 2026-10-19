//! HTTP client for the tokenbud relay.

use std::fmt;
use std::time::Duration;

use anyhow::{anyhow, Result};
use reqwest::{Method, RequestBuilder};
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::types::*;
use crate::{http, normalize_url, AllowHttp};

/// How long a single long-poll asks the relay to hold the request.
const LONG_POLL_SECS: u64 = 25;
/// Long polls get this much longer than they ask for before the request itself times out.
const REQUEST_SLACK_SECS: u64 = 35;
/// Dropped connections tolerated in a row while waiting for an answer.
const MAX_POLL_FAILURES: u32 = 5;

/// Why a relay request failed. Decisions (end the session? retry?) are made on these, never on
/// message text, which is for people.
#[derive(Debug, Clone, PartialEq)]
pub enum RelayError {
    /// No HTTP answer at all: offline, DNS, TLS, timeout.
    Unreachable,
    /// The relay answered with an error. `code` is the relay's machine-readable reason, when given.
    Http { status: u16, code: Option<String>, message: String },
}

impl RelayError {
    /// The session is over (kicked, timed out, host gone): stop using it.
    pub fn is_session_end(&self) -> bool {
        match self {
            Self::Http { code: Some(c), .. } => c == "session_ended" || c == "not_sharing",
            Self::Http { status, .. } => *status == 401,
            Self::Unreachable => false,
        }
    }

    /// Worth retrying: the network or the relay hiccuped (5xx without a reason we understand).
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Unreachable => true,
            Self::Http { status, code, .. } => *status >= 500 && code.is_none(),
        }
    }

    /// The relay error inside an `anyhow::Error`, if that's what it is.
    pub fn of(e: &anyhow::Error) -> Option<&RelayError> {
        e.downcast_ref::<RelayError>()
    }
}

impl fmt::Display for RelayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable => f.write_str("Could not reach the relay. Check your internet connection."),
            Self::Http { message, .. } => f.write_str(message),
        }
    }
}

impl std::error::Error for RelayError {}

#[derive(Clone)]
pub struct RelayClient {
    base: String,
}

impl RelayClient {
    /// `https://…`, or `http://` for a relay on this computer (development).
    pub fn new(base_url: &str) -> Result<Self> {
        Ok(Self { base: normalize_url(base_url, "https", AllowHttp::Loopback)? })
    }

    /// The WebSocket URL the host connects to.
    pub fn connect_url(&self, host_id: &str) -> String {
        let ws = match self.base.split_once("://") {
            Some(("https", rest)) => format!("wss://{rest}"),
            Some((_, rest)) => format!("ws://{rest}"),
            None => self.base.clone(),
        };
        format!("{ws}/v1/hosts/{host_id}/connect")
    }

    fn req(&self, method: Method, path: &str, token: Option<&str>) -> RequestBuilder {
        let rb = http().request(method, format!("{}{}", self.base, path)).timeout(Duration::from_secs(LONG_POLL_SECS + REQUEST_SLACK_SECS));
        match token {
            Some(t) => rb.bearer_auth(t),
            None => rb,
        }
    }

    async fn send<T: DeserializeOwned>(rb: RequestBuilder) -> Result<T> {
        let resp = rb.send().await.map_err(|_| RelayError::Unreachable)?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            let parsed = serde_json::from_str::<serde_json::Value>(&body).ok();
            let field = |name: &str| parsed.as_ref().and_then(|v| v[name].as_str()).map(str::to_string);
            return Err(RelayError::Http {
                status: status.as_u16(),
                code: field("code"),
                message: field("error").unwrap_or_else(|| format!("relay error {}", status.as_u16())),
            }
            .into());
        }
        serde_json::from_str(&body).map_err(|_| anyhow!("unexpected relay response: {}", crate::text::preview(&body, 200)))
    }

    /// Is this a tokenbud relay? (Checked before saving a relay of your own.)
    pub async fn check(&self) -> Result<()> {
        let health: serde_json::Value = Self::send(self.req(Method::GET, "/health", None))
            .await
            .map_err(|_| anyhow!("No tokenbud relay answered at {}.", self.base))?;
        if health["service"] != "tokenbud-relay" {
            return Err(anyhow!("{} isn't a tokenbud relay.", self.base));
        }
        Ok(())
    }

    pub async fn register(&self) -> Result<RegisterResponse> {
        Self::send(self.req(Method::POST, "/v1/hosts", None)).await
    }

    pub async fn open_session(&self, host_id: &str, password: &str, name: &str) -> Result<SessionResponse> {
        Self::send(
            self.req(Method::POST, &format!("/v1/hosts/{host_id}/sessions"), None).json(&json!({ "password": password, "name": name })),
        )
        .await
    }

    pub async fn close_session(&self, host_id: &str, token: &str) -> Result<()> {
        let _: serde_json::Value = Self::send(self.req(Method::DELETE, &format!("/v1/hosts/{host_id}/sessions"), Some(token))).await?;
        Ok(())
    }

    pub async fn ping(&self, host_id: &str, token: &str) -> Result<PingResponse> {
        Self::send(self.req(Method::GET, &format!("/v1/hosts/{host_id}/ping"), Some(token))).await
    }

    /// Send a prompt and wait for the answer, riding out brief network or relay hiccups.
    pub async fn ask(&self, host_id: &str, token: &str, req: &AskRequest) -> Result<JobView> {
        let mut job: JobView = Self::send(self.req(Method::POST, &format!("/v1/hosts/{host_id}/ask"), Some(token)).json(req)).await?;
        let mut failures = 0;
        while job.status == JobStatus::Running {
            let path = format!("/v1/hosts/{host_id}/jobs/{}?wait={LONG_POLL_SECS}", job.job_id);
            match Self::send(self.req(Method::GET, &path, Some(token))).await {
                Ok(j) => {
                    job = j;
                    failures = 0;
                }
                Err(e) if failures < MAX_POLL_FAILURES && RelayError::of(&e).is_some_and(RelayError::is_transient) => {
                    failures += 1;
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                Err(e) => return Err(e),
            }
        }
        Ok(job)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http_err(status: u16, code: Option<&str>) -> RelayError {
        RelayError::Http { status, code: code.map(str::to_string), message: String::new() }
    }

    #[test]
    fn classifies_relay_errors() {
        assert!(RelayError::Unreachable.is_transient());
        assert!(!RelayError::Unreachable.is_session_end());
        // A Cloudflare 502 page: retry, don't log the person out.
        assert!(http_err(502, None).is_transient());
        assert!(!http_err(502, None).is_session_end());
        assert!(http_err(401, Some("session_ended")).is_session_end());
        assert!(http_err(503, Some("not_sharing")).is_session_end());
        assert!(!http_err(503, Some("paused")).is_session_end());
        assert!(!http_err(503, Some("paused")).is_transient());
        assert!(http_err(401, None).is_session_end());
    }

    #[test]
    fn builds_websocket_urls() {
        let r = RelayClient::new("https://relay.example.dev/").unwrap();
        assert_eq!(r.connect_url("123456789"), "wss://relay.example.dev/v1/hosts/123456789/connect");
        let local = RelayClient::new("http://127.0.0.1:8787").unwrap();
        assert_eq!(local.connect_url("1"), "ws://127.0.0.1:8787/v1/hosts/1/connect");
        assert!(RelayClient::new("http://relay.example.dev").is_err(), "plain http only for this computer");
    }
}
