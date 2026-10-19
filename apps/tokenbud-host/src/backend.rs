//! Picks the engine that answers: a local model, a cloud provider with your own key (Anthropic,
//! OpenAI, Google, ...), or (in development builds only) your own Claude Code.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};

use crate::claude_code;
use crate::config::{Engine, HostConfig};
use crate::engine::{Answer, Job};
use crate::providers::{self, Preset, PresetKind};

/// The longest any single prompt may take.
const TIMEOUT: Duration = Duration::from_secs(600);

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
                let setup = ProviderSetup::from(cfg)?;
                // No pick and no default: the first model the provider lists, as Settings says.
                let model = match providers::pick_model(&cfg.provider_model(setup.preset.id), setup.preset.default_model, &[]) {
                    Ok(m) => m,
                    Err(_) => providers::pick_model("", "", &setup.models().await?)
                        .map_err(|_| anyhow!("Pick a {} model in Settings.", setup.preset.name))?,
                };
                let text = match setup.preset.kind {
                    PresetKind::Anthropic => {
                        providers::anthropic_chat(job, setup.key.as_deref().unwrap_or_default(), &model, TIMEOUT).await?
                    }
                    PresetKind::OpenAiCompatible | PresetKind::Custom => {
                        providers::chat(&setup.base_url, setup.key.as_deref(), &model, job, TIMEOUT, setup.preset.name).await?
                    }
                };
                Ok(Answer { text, cost_usd: None })
            }
            Engine::ClaudeCode => claude_code::answer(job).await,
        }
    };
    tokio::time::timeout(TIMEOUT, fut).await.map_err(|_| anyhow!("no answer after {} minutes", TIMEOUT.as_secs() / 60))?
}

/// The chosen provider, its API address, and your key for it.
struct ProviderSetup {
    preset: &'static Preset,
    base_url: String,
    key: Option<String>,
}

impl ProviderSetup {
    fn from(cfg: &HostConfig) -> Result<Self> {
        let preset = providers::preset(&cfg.provider).ok_or_else(|| anyhow!("Pick a provider in Settings."))?;
        let base_url = match preset.kind {
            PresetKind::Custom if cfg.custom_url.trim().is_empty() => {
                bail!("Enter the address of your OpenAI-compatible API in Settings.")
            }
            PresetKind::Custom => providers::normalize(&cfg.custom_url)?,
            PresetKind::Anthropic | PresetKind::OpenAiCompatible => preset.base_url.to_string(),
        };
        let key = providers::get_key(preset.id)?;
        if key.is_none() && preset.kind != PresetKind::Custom {
            bail!("Add your {} API key in Settings.", preset.name);
        }
        Ok(Self { preset, base_url, key })
    }

    /// The models this provider offers you.
    async fn models(&self) -> Result<Vec<String>> {
        match self.preset.kind {
            PresetKind::Anthropic => providers::anthropic_models(self.key.as_deref().unwrap_or_default()).await,
            PresetKind::OpenAiCompatible | PresetKind::Custom => providers::list_models(&self.base_url, self.key.as_deref()).await,
        }
    }
}

/// Is the engine ready? Ok((description, models it offers)) or Err(what to do about it).
pub async fn check(cfg: &HostConfig) -> Result<(String, Vec<String>)> {
    match cfg.engine() {
        Engine::Provider => {
            let setup = ProviderSetup::from(cfg)?;
            let name = setup.preset.name;
            let models = setup.models().await.map_err(|e| anyhow!("{name} didn't accept the request: {e:#}"))?;
            match providers::pick_model(&cfg.provider_model(setup.preset.id), setup.preset.default_model, &models) {
                Ok(m) if models.is_empty() || models.contains(&m) => Ok((format!("{name} is ready, answering with {m}."), models)),
                Ok(m) => bail!("{name} doesn't offer a model called {m} for this key."),
                Err(_) => bail!("{name} has no models available for this key."),
            }
        }
        Engine::Local => {
            let server = providers::find_local(&cfg.local_url).await?;
            let model = match cfg.local_model.trim() {
                "" => server.models.first().cloned(),
                m => Some(m.to_string()),
            };
            match model {
                Some(m) if server.models.contains(&m) => Ok((format!("{} is running, answering with {m}.", server.name), server.models)),
                Some(m) => bail!("{} is running, but has no model called {m}.", server.name),
                None => bail!("{} is running, but has no models yet. Download one first.", server.name),
            }
        }
        Engine::ClaudeCode => Ok((claude_code::check().await?, vec![])),
    }
}
