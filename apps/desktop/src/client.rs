//! Client mode: connect to someone's shared agent with their ID and password, then chat with it.
//! Chats and memory are local-first: kept only on this computer, in the config folder.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokenbud_client::memory::{self, Memory, MAX_CHATS, MAX_FACT_CHARS};
use tokenbud_client::Seat;
use tokenbud_core::types::Paused;
use tokenbud_core::{now_ms, store, RelayError};

const PING_EVERY: Duration = Duration::from_secs(15);
/// How long closing the window waits to give the seat back.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const CONFIG_FILE: &str = "client.json";
const CHATS_FILE: &str = "chats.json";
const MEMORY_FILE: &str = "memory.json";

/// Remembered between runs, so you don't retype the ID.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct ClientConfig {
    last_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MessageState {
    Running,
    Done,
    Error,
}

#[derive(Clone, Serialize, Deserialize)]
struct Message {
    prompt: String,
    state: MessageState,
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
    seat: Option<Seat>,
    online: bool,
    paused: Option<Paused>,
    /// Bumped on every connect/disconnect, so an old heartbeat knows to stop.
    generation: u64,
    /// Something to tell the user: why the last session ended, or a file that couldn't be read.
    notice: Option<String>,
    chats: Vec<Chat>,
    next_chat: u64,
    last_id: String,
    memory: Memory,
}

impl Inner {
    /// Answers still coming won't arrive any more.
    fn fail_running(&mut self, why: &str) {
        for m in self.chats.iter_mut().flat_map(|c| c.messages.iter_mut()).filter(|m| m.state == MessageState::Running) {
            m.state = MessageState::Error;
            m.error = Some(why.into());
        }
    }
}

/// Saves a file off the UI thread. Only the newest version is written, even if saves overlap.
#[derive(Default)]
struct Saver {
    latest: AtomicU64,
    writing: Mutex<()>,
}

impl Saver {
    fn save<T: Serialize + Send + 'static>(self: &Arc<Self>, file: &'static str, value: T) {
        let version = self.latest.fetch_add(1, Ordering::SeqCst) + 1;
        let saver = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _writing = saver.writing.lock().unwrap_or_else(|e| e.into_inner());
            if saver.latest.load(Ordering::SeqCst) == version {
                if let Err(e) = store::save_json_compact(file, &value) {
                    eprintln!("tokenbud: couldn't save {file}: {e:#}");
                }
            }
        });
    }
}

pub struct Client {
    inner: Arc<Mutex<Inner>>,
    chats_saver: Arc<Saver>,
    memory_saver: Arc<Saver>,
}

impl Client {
    pub fn load() -> Self {
        let mut notices = vec![];
        let (cfg, note) = store::load_json_or_backup::<ClientConfig>(CONFIG_FILE);
        notices.extend(note);
        let (mut chats, note) = store::load_json_or_backup::<Vec<Chat>>(CHATS_FILE);
        notices.extend(note);
        let (memory, note) = store::load_json_or_backup::<Memory>(MEMORY_FILE);
        notices.extend(note);
        for m in chats.iter_mut().flat_map(|c| c.messages.iter_mut()).filter(|m| m.state == MessageState::Running) {
            m.state = MessageState::Error;
            m.error = Some("tokenbud closed before the answer arrived.".into());
        }
        let notice = (!notices.is_empty()).then(|| notices.join(" "));
        Self {
            inner: Arc::new(Mutex::new(Inner { last_id: cfg.last_id, chats, memory, notice, ..Default::default() })),
            chats_saver: Default::default(),
            memory_saver: Default::default(),
        }
    }

    fn save_chats(&self, inner: &mut Inner) {
        inner.chats.truncate(MAX_CHATS);
        self.chats_saver.save(CHATS_FILE, inner.chats.clone());
    }

    /// The seat to give back when the window closes (taken, so it's only closed once).
    pub fn take_seat(&self) -> Option<Seat> {
        self.inner.lock().unwrap().seat.take()
    }
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
        connection: inner.seat.as_ref().map(|s| ConnectionView {
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

/// Drop the seat (if it's still the one from `generation`) and say why.
fn end_session(app: &Client, handle: &AppHandle, generation: u64, why: Option<String>) {
    let mut i = app.inner.lock().unwrap();
    if i.generation != generation || i.seat.is_none() {
        return;
    }
    i.seat = None;
    i.generation += 1;
    i.notice = why;
    i.fail_running("Disconnected before the answer arrived.");
    app.save_chats(&mut i);
    drop(i);
    changed(handle);
}

#[tauri::command]
pub async fn connect(app: State<'_, Client>, handle: AppHandle, id: String, password: String) -> Result<(), String> {
    let seat = Seat::open(&id, &password).await.map_err(|e| format!("{e:#}"))?;
    let generation = {
        let mut i = app.inner.lock().unwrap();
        if let Some(old) = i.seat.replace(seat.clone()) {
            tauri::async_runtime::spawn(async move { old.close().await });
        }
        i.online = true;
        i.paused = None;
        i.notice = None;
        i.generation += 1;
        i.last_id = seat.host_id.clone();
        let last_id = i.last_id.clone();
        tauri::async_runtime::spawn_blocking(move || store::save_json(CONFIG_FILE, &ClientConfig { last_id }));
        i.generation
    };
    changed(&handle);

    // Keep the seat while connected, and notice when the session ends.
    let inner = app.inner.clone();
    let chats_saver = app.chats_saver.clone();
    let memory_saver = app.memory_saver.clone();
    tauri::async_runtime::spawn(async move {
        let app = Client { inner, chats_saver, memory_saver };
        loop {
            tokio::time::sleep(PING_EVERY).await;
            if app.inner.lock().unwrap().generation != generation {
                return;
            }
            match seat.ping().await {
                Ok(p) => {
                    let mut i = app.inner.lock().unwrap();
                    i.online = p.online;
                    i.paused = p.paused;
                    drop(i);
                    changed(&handle);
                }
                Err(e) => match RelayError::of(&e) {
                    // Kicked, timed out, or the host stopped sharing: this seat is gone.
                    Some(r) if r.is_session_end() => return end_session(&app, &handle, generation, Some(r.to_string())),
                    // A network or relay hiccup: show it, keep the seat, try again next time.
                    _ => {
                        app.inner.lock().unwrap().online = false;
                        changed(&handle);
                    }
                },
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn disconnect(app: State<Client>, handle: AppHandle) {
    let (seat, generation) = {
        let i = app.inner.lock().unwrap();
        (i.seat.clone(), i.generation)
    };
    if let Some(s) = seat {
        tauri::async_runtime::spawn(async move { s.close().await });
    }
    end_session(&app, &handle, generation, None);
}

#[tauri::command]
pub fn clear_notice(app: State<Client>, handle: AppHandle) {
    app.inner.lock().unwrap().notice = None;
    changed(&handle);
}

/// Send a prompt in a chat (`None` starts a new one). Returns the chat's id.
#[tauri::command]
pub fn send(app: State<Client>, handle: AppHandle, chat_id: Option<String>, prompt: String) -> Result<String, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Write something first.".into());
    }
    let (seat, generation, chat_id, history, index, context) = {
        let mut i = app.inner.lock().unwrap();
        let seat = i.seat.clone().ok_or("You're not connected.")?;
        let generation = i.generation;
        let chat_id = match chat_id.filter(|id| i.chats.iter().any(|c| &c.id == id)) {
            Some(id) => id,
            None => {
                i.next_chat += 1;
                let id = format!("chat{:x}{}", now_ms(), i.next_chat);
                i.chats.insert(0, Chat { id: id.clone(), title: memory::title_of(&prompt), messages: vec![] });
                id
            }
        };
        let pos = i.chats.iter().position(|c| c.id == chat_id).expect("the chat was just found or created");
        // Most recently used chat first.
        let mut chat = i.chats.remove(pos);
        if chat.messages.iter().any(|m| m.state == MessageState::Running) {
            i.chats.insert(pos, chat);
            return Err("Wait for the answer first.".into());
        }
        let history = memory::history(chat.messages.iter().map(|m| (m.prompt.as_str(), m.answer.as_deref())));
        chat.messages.push(Message { prompt: prompt.clone(), state: MessageState::Running, answer: None, error: None, at: now_ms() });
        let index = chat.messages.len() - 1;
        i.chats.insert(0, chat);
        app.save_chats(&mut i);
        (seat, generation, chat_id, history, index, i.memory.context())
    };
    changed(&handle);

    let inner = app.inner.clone();
    let (chats_saver, memory_saver) = (app.chats_saver.clone(), app.memory_saver.clone());
    let id = chat_id.clone();
    tauri::async_runtime::spawn(async move {
        let app = Client { inner, chats_saver, memory_saver };
        let result = seat.ask(&prompt, history, context).await;
        let ended = matches!(&result, Err(e) if RelayError::of(e).is_some_and(RelayError::is_session_end));
        {
            let mut i = app.inner.lock().unwrap();
            if let Some(m) = i.chats.iter_mut().find(|c| c.id == id).and_then(|c| c.messages.get_mut(index)) {
                match result {
                    Ok(text) => {
                        m.state = MessageState::Done;
                        m.answer = Some(text);
                    }
                    Err(e) => {
                        m.state = MessageState::Error;
                        m.error = Some(format!("{e:#}"));
                    }
                }
            }
            app.save_chats(&mut i);
        }
        if ended {
            end_session(&app, &handle, generation, Some("The session ended.".into()));
        }
        changed(&handle);
    });
    Ok(chat_id)
}

#[tauri::command]
pub fn delete_chat(app: State<Client>, handle: AppHandle, chat_id: String) {
    let mut i = app.inner.lock().unwrap();
    i.chats.retain(|c| c.id != chat_id);
    app.save_chats(&mut i);
    drop(i);
    changed(&handle);
}

// ----- memory -----

/// Change the memory, save it, and tell the window.
fn with_memory(app: &State<Client>, handle: &AppHandle, f: impl FnOnce(&mut Memory) -> Result<(), String>) -> Result<(), String> {
    let mut i = app.inner.lock().unwrap();
    f(&mut i.memory)?;
    app.memory_saver.save(MEMORY_FILE, i.memory.clone());
    drop(i);
    changed(handle);
    Ok(())
}

#[tauri::command]
pub fn add_memory(app: State<Client>, handle: AppHandle, text: String) -> Result<(), String> {
    with_memory(&app, &handle, |m| {
        let id = format!("f{:x}{}", now_ms(), m.facts.len());
        m.add(&text, id, now_ms())
    })
}

#[tauri::command]
pub fn update_memory(app: State<Client>, handle: AppHandle, id: String, text: String) -> Result<(), String> {
    let text = memory::clean_fact(&text)?;
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
    if text.chars().count() > MAX_FACT_CHARS {
        return Err("That suggestion is too long.".into());
    }
    with_memory(&app, &handle, |m| {
        m.dismiss(&text);
        Ok(())
    })
}
