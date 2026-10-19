//! Development harness: share without the desktop app, for testing against a local relay.
//!
//!   TOKENBUD_RELAY=http://127.0.0.1:8787 TOKENBUD_HOME=/tmp/tb TOKENBUD_PLAIN_SECRETS=1 \
//!     cargo run -p tokenbud-host --example share
//!
//! Not shipped; the desktop app's host mode is the real thing.

use std::sync::Arc;
use std::time::Duration;

use tokenbud_host::config::HostConfig;
use tokenbud_host::service::{Service, Status};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let service = Service::start(HostConfig::load()?, Arc::new(|line| {
        if !line.is_empty() {
            eprintln!("{line}");
        }
    }), true)?;
    loop {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if service.shared.lock().unwrap().status == Status::Ready {
            break;
        }
    }
    let id = service.config.read().unwrap().current_host_id().unwrap_or_default();
    println!("ID:       {id}");
    println!("Password: {}", service.shared.lock().unwrap().password);
    tokio::signal::ctrl_c().await?;
    Ok(())
}
