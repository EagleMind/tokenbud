//! Local storage: JSON config files in the user's config dir, and secrets in the OS keychain.

use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::{de::DeserializeOwned, Serialize};

const KEYRING_SERVICE: &str = "tokenbud";
const SECRETS_FILE: &str = "secrets.json";

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

/// Read a JSON file; a missing file is the default. A file that doesn't parse is an error.
pub fn load_json<T: DeserializeOwned + Default>(file: &str) -> Result<T> {
    let path = data_dir()?.join(file);
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).with_context(|| format!("parsing {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Like `load_json`, but a damaged file is moved aside (`<name>.corrupt-<time>.json`) instead of
/// being overwritten with defaults on the next save. Returns what to tell the user, if anything.
pub fn load_json_or_backup<T: DeserializeOwned + Default>(file: &str) -> (T, Option<String>) {
    match load_json(file) {
        Ok(v) => (v, None),
        Err(e) => {
            let backup = data_dir().ok().and_then(|dir| {
                let stem = file.trim_end_matches(".json");
                let to = dir.join(format!("{stem}.corrupt-{}.json", crate::now_ms()));
                fs::rename(dir.join(file), &to).ok().map(|_| to)
            });
            let note = match backup {
                Some(to) => format!("{file} couldn't be read ({e:#}), so it was set aside as {} and started fresh.", to.display()),
                None => format!("{file} couldn't be read ({e:#}); starting fresh."),
            };
            (T::default(), Some(note))
        }
    }
}

/// Write a JSON file atomically (temp file + rename), readable by people.
pub fn save_json<T: Serialize>(file: &str, value: &T) -> Result<()> {
    write_atomic(file, &serde_json::to_vec_pretty(value)?, false)
}

/// Like `save_json`, without whitespace: for large files rewritten often (chats).
pub fn save_json_compact<T: Serialize>(file: &str, value: &T) -> Result<()> {
    write_atomic(file, &serde_json::to_vec(value)?, false)
}

fn write_atomic(file: &str, bytes: &[u8], private: bool) -> Result<()> {
    let path = data_dir()?.join(file);
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = private;
    fs::rename(&tmp, &path).with_context(|| format!("writing {}", path.display()))
}

// ----- secrets -----
//
// Secrets go to the OS keychain (Windows Credential Manager, macOS Keychain, Linux
// kernel keyring). Set TOKENBUD_PLAIN_SECRETS=1 to keep them in secrets.json instead
// (readable only by you on Unix), e.g. on a headless Linux box where the kernel keyring
// doesn't survive reboots.

fn plain_secrets() -> bool {
    std::env::var("TOKENBUD_PLAIN_SECRETS").map(|v| v == "1").unwrap_or(false)
}

type SecretMap = std::collections::BTreeMap<String, String>;

fn save_secrets(map: &SecretMap) -> Result<()> {
    write_atomic(SECRETS_FILE, &serde_json::to_vec_pretty(map)?, true)
}

pub fn get_secret(key: &str) -> Result<Option<String>> {
    if plain_secrets() {
        let map: SecretMap = load_json(SECRETS_FILE)?;
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
        let mut map: SecretMap = load_json(SECRETS_FILE)?;
        map.insert(key.into(), value.into());
        return save_secrets(&map);
    }
    keyring::Entry::new(KEYRING_SERVICE, key)?.set_password(value).map_err(|e| anyhow!("saving {key} to the keychain: {e}"))
}

pub fn delete_secret(key: &str) -> Result<()> {
    if plain_secrets() {
        let mut map: SecretMap = load_json(SECRETS_FILE)?;
        map.remove(key);
        return save_secrets(&map);
    }
    match keyring::Entry::new(KEYRING_SERVICE, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!("deleting {key} from the keychain: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_a_damaged_file_aside_instead_of_losing_it() {
        // The only test in this crate that touches the data dir, so setting it here is safe.
        let home = std::env::temp_dir().join(format!("tokenbud-store-test-{}", std::process::id()));
        std::env::set_var("TOKENBUD_HOME", &home);

        save_json("good.json", &vec![1, 2]).unwrap();
        let (good, note): (Vec<u32>, _) = load_json_or_backup("good.json");
        assert_eq!((good, note), (vec![1, 2], None));

        let (missing, note): (Vec<u32>, _) = load_json_or_backup("missing.json");
        assert_eq!((missing, note), (vec![], None));

        fs::write(home.join("chats.json"), "{ not json").unwrap();
        let (chats, note): (Vec<u32>, _) = load_json_or_backup("chats.json");
        assert!(chats.is_empty());
        assert!(note.unwrap().contains("set aside"));
        assert!(!home.join("chats.json").exists());
        let kept: Vec<_> = fs::read_dir(&home).unwrap().filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
        let backup = kept.iter().find(|n| n.starts_with("chats.corrupt-")).expect("a backup");
        assert_eq!(fs::read_to_string(home.join(backup)).unwrap(), "{ not json");

        let _ = fs::remove_dir_all(&home);
    }
}
