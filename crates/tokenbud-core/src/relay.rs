//! HTTP client for the tokenbud relay.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::{Method, RequestBuilder};
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::types::*;

/// How long a single long-poll asks the relay to hold the request.
pub const LONG_POLL_SECS: u64 = 25;
const UNREACHABLE: &str = "Could not reach the relay. Check your internet connection.";

#[derive(Clone)]
pub struct RelayClient {
    base: String,
    http: reqwest::Client,
}

impl RelayClient {
    pub fn new(base_url: &str) -> Result<Self> {
        let base = base_url.trim().trim_end_matches('/').to_string();
        if !(base.starts_with("http://") || base.starts_with("https://")) {
            return Err(anyhow!("relay URL must start with http:// or https://"));
        }
        let http = reqwest::Client::builder()
            .user_agent(concat!("tokenbud/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(LONG_POLL_SECS + 35))
            .build()?;
        Ok(Self { base, http })
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
        let rb = self.http.request(method, format!("{}{}", self.base, path));
        match token {
            Some(t) => rb.bearer_auth(t),
            None => rb,
        }
    }

    async fn send<T: DeserializeOwned>(rb: RequestBuilder) -> Result<T> {
        let resp = rb.send().await.context(UNREACHABLE)?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            let msg = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| format!("relay error {}", status.as_u16()));
            return Err(anyhow!(msg));
        }
        serde_json::from_str(&body).with_context(|| format!("unexpected relay response: {body}"))
    }

    /// Is this a tokenbud relay, and up to date? (Checked before saving a relay of your own.)
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
            self.req(Method::POST, &format!("/v1/hosts/{host_id}/sessions"), None)
                .json(&json!({ "password": password, "name": name })),
        )
        .await
    }

    pub async fn close_session(&self, host_id: &str, token: &str) -> Result<()> {
        let _: serde_json::Value =
            Self::send(self.req(Method::DELETE, &format!("/v1/hosts/{host_id}/sessions"), Some(token))).await?;
        Ok(())
    }

    pub async fn ping(&self, host_id: &str, token: &str) -> Result<PingResponse> {
        Self::send(self.req(Method::GET, &format!("/v1/hosts/{host_id}/ping"), Some(token))).await
    }

    /// Send a prompt and wait for the answer.
    pub async fn ask(&self, host_id: &str, token: &str, req: &AskRequest) -> Result<JobView> {
        let mut job: JobView =
            Self::send(self.req(Method::POST, &format!("/v1/hosts/{host_id}/ask"), Some(token)).json(req)).await?;
        let mut failures = 0;
        while job.status == JobStatus::Running {
            let path = format!("/v1/hosts/{host_id}/jobs/{}?wait={LONG_POLL_SECS}", job.job_id);
            match Self::send(self.req(Method::GET, &path, Some(token))).await {
                Ok(j) => {
                    job = j;
                    failures = 0;
                }
                // A dropped connection mid-wait: retry a few times before giving up.
                Err(e) if failures < 5 && e.to_string() == UNREACHABLE => {
                    failures += 1;
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                Err(e) => return Err(e),
            }
        }
        Ok(job)
    }
}
