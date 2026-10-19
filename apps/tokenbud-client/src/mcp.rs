//! A minimal MCP server over stdio, so your own agent can prompt a host's agent.
//!
//! One tool, `ask`. Each call takes a seat on the host for as long as it runs.
//! Messages are newline-delimited JSON-RPC 2.0.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::Seat;

const DEFAULT_PROTOCOL: &str = "2025-06-18";

pub async fn serve(id: String, password: String) -> Result<()> {
    let creds = Arc::new((id, password));
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut tasks = tokio::task::JoinSet::new();

    while let Some(line) = lines.next_line().await? {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue }; // notifications need no reply
        let method = msg["method"].as_str().unwrap_or_default().to_string();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let (out, creds) = (stdout.clone(), creds.clone());
        // Prompts can take minutes; handle each request on its own task.
        tasks.spawn(async move {
            let reply = match handle(&method, params, &creds).await {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err(message) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": message } }),
            };
            let mut out = out.lock().await;
            let _ = out.write_all(format!("{reply}\n").as_bytes()).await;
            let _ = out.flush().await;
        });
    }
    // stdin closed: finish answering what was already asked before exiting.
    while tasks.join_next().await.is_some() {}
    Ok(())
}

async fn handle(method: &str, params: Value, creds: &(String, String)) -> Result<Value, String> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": params["protocolVersion"].as_str().unwrap_or(DEFAULT_PROTOCOL),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "tokenbud", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [{
            "name": "ask",
            "description": "Send a prompt to another person's AI agent (shared with you through tokenbud) and wait \
                            for its answer. It runs on their computer and sees only the prompt, so include all the \
                            context it needs.",
            "inputSchema": {
                "type": "object",
                "properties": { "prompt": { "type": "string", "description": "The full, self-contained prompt." } },
                "required": ["prompt"],
                "additionalProperties": false,
            },
        }]})),
        "tools/call" => {
            let prompt = params["arguments"]["prompt"].as_str().unwrap_or_default().to_string();
            let result = async {
                if prompt.trim().is_empty() {
                    anyhow::bail!("prompt is required");
                }
                let seat = Seat::open(&creds.0, &creds.1).await?;
                let answer = seat.ask(&prompt, vec![], None).await;
                seat.close().await;
                answer
            }
            .await;
            Ok(match result {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
                Err(e) => json!({ "content": [{ "type": "text", "text": format!("{e:#}") }], "isError": true }),
            })
        }
        _ => Err(format!("method not found: {method}")),
    }
}
