//! Client mode: connect to someone's shared agent with their ID and password, then chat with it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokenbud_client::Session;
use tokenbud_core::types::{Paused, Role, Turn};
use tokenbud_core::{now_ms, store};

const PING_EVERY: Duration = Duration::from_secs(15);
const CONFIG_FILE: &str = "client.json";
// Local-first memory: kept only on this computer, in the config folder.
const CHATS_FILE: &str = "chats.json";
const MEMORY_FILE: &str = "memory.json";
const MAX_CHATS: usize = 100;
const MAX_FACTS: usize = 50;
const MAX_FACT_CHARS: usize = 300;

/// Remembered between runs, so you don't retype the ID.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct ClientConfig {
    last_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Message {
    prompt: String,
    /// running | done | error
    state: String,
    answer: Option<String>,
    error: Option<String>,
    at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Chat {
    id: String,
    title: String,
    messages: Vec<Message>,
}

/// Facts about you that travel with each prompt (when enabled), so the agent knows you.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Memory {
    enabled: bool,
    facts: Vec<Fact>,
    /// Suggestions you said "Not now" to, so they aren't offered again.
    dismissed: Vec<String>,
}

impl Default for Memory {
    fn default() -> Self {
        Self { enabled: true, facts: vec![], dismissed: vec![] }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Fact {
    id: String,
    text: String,
    at: i64,
}

impl Memory {
    /// The system prompt that carries your memory to the host's agent.
    /// Mirrors `buildContext` in desktop/src/client/backend.ts.
    fn context(&self) -> Option<String> {
        if !self.enabled {
            return None;
        }
        let mut out = String::new();
        if !self.facts.is_empty() {
            out.push_str("What you know about the person asking, from their own saved notes:\n");
            for f in &self.facts {
                out.push_str(&format!("- {}\n", f.text));
            }
            out.push('\n');
        }
        out.push_str(REMEMBER_INSTRUCTION);
        Some(out)
    }
}

const REMEMBER_INSTRUCTION: &str = "If they share a lasting fact about themselves or a preference worth remembering in \
future conversations, end your reply with <remember>one short fact, like \"Prefers short answers\"</remember> \
(at most two). Otherwise don't add it, and never mention these tags.";

/// Answers may end with <remember>...</remember> suggestions; the agent shouldn't see them again in the history.
fn strip_remember(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<remember>") {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find("</remember>") {
            Some(end) => &rest[start + end + "</remember>".len()..],
            None => "",
        };
    }
    out.push_str(rest);
    out.trim_end().to_string()
}

#[derive(Clone, Serialize)]
struct ConnectionView {
    host_id: String,
    host_name: String,
    online: bool,
    /// The host's reserve paused sharing.
    paused: Option<Paused>,
}

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    online: bool,
    paused: Option<Paused>,
    /// Bumped on every connect/disconnect, so an old heartbeat knows to stop.
    generation: u64,
    /// Why the last session ended, if it wasn't you.
    notice: Option<String>,
    chats: Vec<Chat>,
    next_chat: u64,
    last_id: String,
    memory: Memory,
}

impl Inner {
    fn save_chats(&mut self) {
        self.chats.truncate(MAX_CHATS);
        let _ = store::save_json(CHATS_FILE, &self.chats);
    }

    fn save_memory(&self) {
        let _ = store::save_json(MEMORY_FILE, &self.memory);
    }
}

pub struct Client {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Serialize)]
pub struct ClientView {
    connection: Option<ConnectionView>,
    notice: Option<String>,
    last_id: String,
    chats: Vec<Chat>,
    memory: Memory,
}

fn changed(handle: &AppHandle) {
    let _ = handle.emit("client-changed", ());
}

#[tauri::command]
pub fn client_state(app: State<Client>) -> ClientView {
    let inner = app.inner.lock().unwrap();
    ClientView {
        connection: inner.session.as_ref().map(|s| ConnectionView {
            host_id: s.host_id.clone(),
            host_name: s.host_name.clone(),
            online: inner.online,
            paused: inner.paused.clone(),
        }),
        notice: inner.notice.clone(),
        last_id: inner.last_id.clone(),
        chats: inner.chats.clone(),
        memory: inner.memory.clone(),
    }
}

/// Drop the session (if it's still the one from `generation`) and say why.
fn end_session(inner: &Arc<Mutex<Inner>>, handle: &AppHandle, generation: u64, why: Option<String>) {
    let mut i = inner.lock().unwrap();
    if i.generation != generation || i.session.is_none() {
        return;
    }
    i.session = None;
    i.generation += 1;
    i.notice = why;
    for m in i.chats.iter_mut().flat_map(|c| c.messages.iter_mut()).filter(|m| m.state == "running") {
        m.state = "error".into();
        m.error = Some("Disconnected before the answer arrived.".into());
    }
    i.save_chats();
    drop(i);
    changed(handle);
}

#[tauri::command]
pub async fn connect(app: State<'_, Client>, handle: AppHandle, id: String, password: String) -> Result<(), String> {
    let session = Session::open(&id, &password).await.map_err(|e| format!("{e:#}"))?;
    let generation = {
        let mut i = app.inner.lock().unwrap();
        if let Some(old) = i.session.replace(session.clone()) {
            tauri::async_runtime::spawn(async move { old.close().await });
        }
        i.online = true;
        i.paused = None;
        i.notice = None;
        i.generation += 1;
        i.last_id = session.host_id.clone();
        let _ = store::save_json(CONFIG_FILE, &ClientConfig { last_id: i.last_id.clone() });
        i.generation
    };
    changed(&handle);

    // Keep the seat while connected, and notice when the session ends.
    let inner = app.inner.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PING_EVERY).await;
            if inner.lock().unwrap().generation != generation {
                return;
            }
            match session.ping().await {
                Ok(p) => {
                    let mut i = inner.lock().unwrap();
                    i.online = p.online;
                    i.paused = p.paused;
                    drop(i);
                    changed(&handle);
                }
                Err(e) if e.to_string().starts_with("Could not reach") => {
                    inner.lock().unwrap().online = false;
                    changed(&handle);
                }
                Err(e) => return end_session(&inner, &handle, generation, Some(format!("{e:#}"))),
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn disconnect(app: State<Client>, handle: AppHandle) {
    let (session, generation) = {
        let i = app.inner.lock().unwrap();
        (i.session.clone(), i.generation)
    };
    if let Some(s) = session {
        tauri::async_runtime::spawn(async move { s.close().await });
    }
    end_session(&app.inner, &handle, generation, None);
}

#[tauri::command]
pub fn clear_notice(app: State<Client>, handle: AppHandle) {
    app.inner.lock().unwrap().notice = None;
    changed(&handle);
}

fn title_of(prompt: &str) -> String {
    let line = prompt.lines().find(|l| !l.trim().is_empty()).unwrap_or("New chat").trim();
    let mut t: String = line.chars().take(48).collect();
    if line.chars().count() > 48 {
        t.push('…');
    }
    t
}

/// Send a prompt in a chat (`None` starts a new one). Returns the chat's id.
#[tauri::command]
pub fn send(app: State<Client>, handle: AppHandle, chat_id: Option<String>, prompt: String) -> Result<String, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Write something first.".into());
    }
    let (session, generation, chat_id, history, index, context) = {
        let mut i = app.inner.lock().unwrap();
        let session = i.session.clone().ok_or("You're not connected.")?;
        let generation = i.generation;
        let chat_id = match chat_id.filter(|id| i.chats.iter().any(|c| &c.id == id)) {
            Some(id) => id,
            None => {
                i.next_chat += 1;
                let id = format!("chat{:x}{}", now_ms(), i.next_chat);
                i.chats.insert(0, Chat { id: id.clone(), title: title_of(&prompt), messages: vec![] });
                id
            }
        };
        let chat = i.chats.iter_mut().find(|c| c.id == chat_id).expect("chat exists");
        if chat.messages.iter().any(|m| m.state == "running") {
            return Err("Wait for the answer first.".into());
        }
        let history: Vec<Turn> = chat
            .messages
            .iter()
            .filter_map(|m| m.answer.as_ref().map(|a| (m, a)))
            .flat_map(|(m, a)| [Turn { role: Role::User, content: m.prompt.clone() }, Turn { role: Role::Assistant, content: strip_remember(a) }])
            .collect();
        chat.messages.push(Message { prompt: prompt.clone(), state: "running".into(), answer: None, error: None, at: now_ms() });
        let index = chat.messages.len() - 1;
        // Most recently used chat first.
        let pos = i.chats.iter().position(|c| c.id == chat_id).unwrap();
        let c = i.chats.remove(pos);
        i.chats.insert(0, c);
        i.save_chats();
        (session, generation, chat_id, history, index, i.memory.context())
    };
    changed(&handle);

    let inner = app.inner.clone();
    let id = chat_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = session.ask(&prompt, history, context).await;
        let ended = matches!(&result, Err(e) if e.to_string().starts_with("Your session") || e.to_string().contains("stopped sharing"));
        {
            let mut i = inner.lock().unwrap();
            if let Some(m) = i.chats.iter_mut().find(|c| c.id == id).and_then(|c| c.messages.get_mut(index)) {
                match result {
                    Ok(text) => {
                        m.state = "done".into();
                        m.answer = Some(text);
                    }
                    Err(e) => {
                        m.state = "error".into();
                        m.error = Some(format!("{e:#}"));
                    }
                }
            }
            i.save_chats();
        }
        if ended {
            end_session(&inner, &handle, generation, Some("The session ended.".into()));
        }
        changed(&handle);
    });
    Ok(chat_id)
}

#[tauri::command]
pub fn delete_chat(app: State<Client>, handle: AppHandle, chat_id: String) {
    let mut i = app.inner.lock().unwrap();
    i.chats.retain(|c| c.id != chat_id);
    i.save_chats();
    drop(i);
    changed(&handle);
}

// ----- memory -----

fn clean_fact(text: &str) -> Result<String, String> {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return Err("Write something to remember.".into());
    }
    Ok(t.chars().take(MAX_FACT_CHARS).collect())
}

/// Change the memory, save it, and tell the window.
fn with_memory(app: &State<Client>, handle: &AppHandle, f: impl FnOnce(&mut Memory) -> Result<(), String>) -> Result<(), String> {
    let mut i = app.inner.lock().unwrap();
    f(&mut i.memory)?;
    i.save_memory();
    drop(i);
    changed(handle);
    Ok(())
}

#[tauri::command]
pub fn add_memory(app: State<Client>, handle: AppHandle, text: String) -> Result<(), String> {
    let text = clean_fact(&text)?;
    with_memory(&app, &handle, |m| {
        if m.facts.iter().any(|f| f.text.eq_ignore_ascii_case(&text)) {
            return Ok(());
        }
        if m.facts.len() >= MAX_FACTS {
            return Err(format!("Memory holds up to {MAX_FACTS} facts. Remove one first."));
        }
        m.facts.push(Fact { id: format!("f{:x}{}", now_ms(), m.facts.len()), text, at: now_ms() });
        Ok(())
    })
}

#[tauri::command]
pub fn update_memory(app: State<Client>, handle: AppHandle, id: String, text: String) -> Result<(), String> {
    let text = clean_fact(&text)?;
    with_memory(&app, &handle, |m| {
        if let Some(f) = m.facts.iter_mut().find(|f| f.id == id) {
            f.text = text;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_memory(app: State<Client>, handle: AppHandle, id: String) -> Result<(), String> {
    with_memory(&app, &handle, |m| {
        m.facts.retain(|f| f.id != id);
        Ok(())
    })
}

#[tauri::command]
pub fn set_memory_enabled(app: State<Client>, handle: AppHandle, enabled: bool) -> Result<(), String> {
    with_memory(&app, &handle, |m| {
        m.enabled = enabled;
        Ok(())
    })
}

#[tauri::command]
pub fn dismiss_suggestion(app: State<Client>, handle: AppHandle, text: String) -> Result<(), String> {
    with_memory(&app, &handle, |m| {
        if !m.dismissed.contains(&text) {
            m.dismissed.push(text);
            // Only recent ones matter.
            let excess = m.dismissed.len().saturating_sub(200);
            m.dismissed.drain(..excess);
        }
        Ok(())
    })
}

impl Client {
    pub fn load() -> Self {
        let cfg: ClientConfig = store::load_json(CONFIG_FILE).unwrap_or_default();
        let mut chats: Vec<Chat> = store::load_json(CHATS_FILE).unwrap_or_default();
        for m in chats.iter_mut().flat_map(|c| c.messages.iter_mut()).filter(|m| m.state == "running") {
            m.state = "error".into();
            m.error = Some("tokenbud closed before the answer arrived.".into());
        }
        let memory: Memory = store::load_json(MEMORY_FILE).unwrap_or_default();
        Self { inner: Arc::new(Mutex::new(Inner { last_id: cfg.last_id, chats, memory, ..Default::default() })) }
    }

    /// Give the seat back (when the window closes).
    pub fn close(&self) {
        let session = self.inner.lock().unwrap().session.take();
        if let Some(s) = session {
            tauri::async_runtime::block_on(async {
                let _ = tokio::time::timeout(Duration::from_secs(3), s.close()).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_remember_tags() {
        assert_eq!(strip_remember("Sure.\n<remember>Likes tea</remember>"), "Sure.");
        assert_eq!(strip_remember("a <remember>x</remember> b <remember>y"), "a  b");
        assert_eq!(strip_remember("no tags"), "no tags");
    }

    #[test]
    fn context_follows_memory() {
        let mut m = Memory::default();
        assert!(m.context().unwrap().starts_with("If they share"));
        m.facts.push(Fact { id: "f".into(), text: "Writes Go".into(), at: 0 });
        assert!(m.context().unwrap().contains("- Writes Go\n"));
        m.enabled = false;
        assert!(m.context().is_none());
    }
}
