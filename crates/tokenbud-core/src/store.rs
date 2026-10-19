//! Local storage: JSON config files in the user's config dir, and secrets in the OS keychain.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::{de::DeserializeOwned, Serialize};

const KEYRING_SERVICE: &str = "tokenbud";

/// `%APPDATA%\tokenbud\tokenbud\config` on Windows, `~/.config/tokenbud` on Linux, etc.
/// `TOKENBUD_HOME` overrides it (useful for running several instances on one machine).
pub fn data_dir() -> Result<PathBuf> {
    let dir = match std::env::var_os("TOKENBUD_HOME") {
        Some(p) => PathBuf::from(p),
        None => directories::ProjectDirs::from("dev", "tokenbud", "tokenbud")
            .ok_or_else(|| anyhow!("could not find a config directory"))?
            .config_dir()
            .to_path_buf(),
    };
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir)
}

pub fn load_json<T: DeserializeOwned + Default>(file: &str) -> Result<T> {
    let path = data_dir()?.join(file);
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).with_context(|| format!("parsing {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

pub fn save_json<T: Serialize>(file: &str, value: &T) -> Result<()> {
    let path = data_dir()?.join(file);
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, &path).with_context(|| format!("writing {}", path.display()))
}

/// Append one JSON line to a local log file.
pub fn append_jsonl<T: Serialize>(file: &str, value: &T) -> Result<()> {
    let path = data_dir()?.join(file);
    let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(f, "{}", serde_json::to_string(value)?)?;
    Ok(())
}

/// Read the last `limit` entries of a JSON-lines file, skipping lines that don't parse.
pub fn read_jsonl<T: DeserializeOwned>(file: &str, limit: usize) -> Result<Vec<T>> {
    let path = data_dir()?.join(file);
    let text = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(limit);
    Ok(lines[start..].iter().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

// ----- secrets -----
//
// Secrets go to the OS keychain (Windows Credential Manager, macOS Keychain, Linux
// kernel keyring). Set TOKENBUD_PLAIN_SECRETS=1 to keep them in secrets.json instead,
// e.g. on a headless Linux box where the kernel keyring doesn't survive reboots.

fn plain_secrets() -> bool {
    std::env::var("TOKENBUD_PLAIN_SECRETS").map(|v| v == "1").unwrap_or(false)
}

type SecretMap = std::collections::BTreeMap<String, String>;

pub fn get_secret(key: &str) -> Result<Option<String>> {
    if plain_secrets() {
        let map: SecretMap = load_json("secrets.json")?;
        return Ok(map.get(key).cloned());
    }
    match keyring::Entry::new(KEYRING_SERVICE, key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!("reading {key} from the keychain: {e}")),
    }
}

pub fn set_secret(key: &str, value: &str) -> Result<()> {
    if plain_secrets() {
        let mut map: SecretMap = load_json("secrets.json")?;
        map.insert(key.into(), value.into());
        return save_json("secrets.json", &map);
    }
    keyring::Entry::new(KEYRING_SERVICE, key)?
        .set_password(value)
        .map_err(|e| anyhow!("saving {key} to the keychain: {e}"))
}

pub fn delete_secret(key: &str) -> Result<()> {
    if plain_secrets() {
        let mut map: SecretMap = load_json("secrets.json")?;
        map.remove(key);
        return save_json("secrets.json", &map);
    }
    match keyring::Entry::new(KEYRING_SERVICE, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!("deleting {key} from the keychain: {e}")),
    }
}
