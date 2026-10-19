// The web client's backend: talks to the relay straight from the browser (same origin,
// since the relay Worker serves this page). Mirrors apps/desktop/src/client.rs.

import { useSyncExternalStore } from "react";

import {
  buildContext,
  type Chat,
  cleanFact,
  type ClientBackend,
  type ClientState,
  MAX_CHATS,
  MAX_FACTS,
  type Memory,
  type Paused,
  splitSuggestions,
} from "@/client/backend";
import * as idb from "./idb";

const PING_EVERY_MS = 15_000;
const LONG_POLL_SECS = 25;
// Per tab: lets a refresh reconnect on its own. Gone when the tab closes.
const TAB_KEY = "tokenbud-session";
const LAST_ID_KEY = "tokenbud-last-id";
// Older versions kept chats per tab here; they move to IndexedDB once.
const OLD_CHATS_KEY = "tokenbud-chats";

type Turn = { role: "user" | "assistant"; content: string };
type Job = { job_id: string; status: "running" | "done" | "error"; text: string | null; error: string | null };

class Unreachable extends Error {
  constructor() {
    super("Could not reach the relay. Check your internet connection.");
  }
}

async function api<T>(method: string, path: string, token?: string, body?: unknown, keepalive = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      keepalive,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Unreachable();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `relay error ${res.status}`);
  return data as T;
}

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    /* storage blocked: works, just isn't remembered */
  }
}

function interrupted(chats: Chat[]): Chat[] {
  return chats.map((c) => ({
    ...c,
    messages: c.messages.map((m) =>
      m.state === "running" ? { ...m, state: "error" as const, error: "The page closed before the answer arrived." } : m,
    ),
  }));
}

let state: ClientState = {
  connection: null,
  notice: null,
  last_id: read(() => localStorage, LAST_ID_KEY) ?? "",
  chats: [],
  memory: { enabled: true, facts: [], dismissed: [] },
};
let loaded = false;
let session: { hostId: string; token: string; generation: number } | null = null;
let generation = 0;
let nextChat = 0;
const listeners = new Set<() => void>();

function set(patch: Partial<ClientState>) {
  state = { ...state, ...patch };
  // Local-first: chats and memory are saved in this browser on every change.
  if (patch.chats) void idb.set("chats", state.chats.slice(0, MAX_CHATS));
  if (patch.memory) void idb.set("memory", state.memory);
  listeners.forEach((l) => l());
}

/** Read chats and memory from IndexedDB (and carry over chats from older per-tab storage). */
async function load() {
  let chats = (await idb.get<Chat[]>("chats")) ?? [];
  const old = read(() => sessionStorage, OLD_CHATS_KEY);
  if (old) {
    try {
      const known = new Set(chats.map((c) => c.id));
      chats = [...(JSON.parse(old) as Chat[]).filter((c) => !known.has(c.id)), ...chats];
    } catch {
      /* unreadable: skip it */
    }
    write(() => sessionStorage, OLD_CHATS_KEY, null);
  }
  const memory = (await idb.get<Memory>("memory")) ?? state.memory;
  loaded = true;
  set({ chats: interrupted(chats), memory });
}

function updateChats(f: (chats: Chat[]) => Chat[]) {
  set({ chats: f(state.chats) });
}

function endSession(gen: number, why: string | null) {
  if (!session || session.generation !== gen) return;
  session = null;
  generation++;
  write(() => sessionStorage, TAB_KEY, null);
  updateChats((chats) =>
    chats.map((c) => ({
      ...c,
      messages: c.messages.map((m) =>
        m.state === "running" ? { ...m, state: "error", error: "Disconnected before the answer arrived." } : m,
      ),
    })),
  );
  set({ connection: null, notice: why });
}

type Saved = { id: string; password: string; name: string; token: string; host_name: string };

async function connect(id: string, password: string, name = "") {
  const hostId = id.replace(/\D/g, "");
  if (hostId.length !== 9) throw new Error("An ID is 9 digits, like 418 203 977.");
  const r = await api<{ session_token: string; host_name: string }>("POST", `/v1/hosts/${hostId}/sessions`, undefined, {
    password: password.trim(),
    name: name || "Someone",
  });
  if (session) void api("DELETE", `/v1/hosts/${session.hostId}/sessions`, session.token).catch(() => {});
  start({ id: hostId, password, name, token: r.session_token, host_name: r.host_name });
}

/** Use a session: remember it for this tab, and keep the seat with regular pings. */
function start(saved: Saved) {
  const gen = ++generation;
  session = { hostId: saved.id, token: saved.token, generation: gen };
  write(() => localStorage, LAST_ID_KEY, saved.id);
  write(() => sessionStorage, TAB_KEY, JSON.stringify(saved));
  set({ connection: { host_id: saved.id, host_name: saved.host_name, online: true }, notice: null, last_id: saved.id });

  const timer = setInterval(async () => {
    if (!session || session.generation !== gen) return clearInterval(timer);
    try {
      const p = await api<{ online: boolean; paused?: Paused | null }>("GET", `/v1/hosts/${saved.id}/ping`, session.token);
      if (state.connection) set({ connection: { ...state.connection, online: p.online, paused: p.paused ?? null } });
    } catch (e) {
      if (e instanceof Unreachable) {
        if (state.connection) set({ connection: { ...state.connection, online: false } });
      } else {
        clearInterval(timer);
        endSession(gen, (e as Error).message);
      }
    }
  }, PING_EVERY_MS);
}

async function disconnect() {
  if (session) {
    void api("DELETE", `/v1/hosts/${session.hostId}/sessions`, session.token).catch(() => {});
    endSession(session.generation, null);
  }
}

function titleOf(prompt: string) {
  const line = prompt.split("\n").find((l) => l.trim())?.trim() ?? "New chat";
  return line.length > 48 ? line.slice(0, 48) + "…" : line;
}

async function send(chatId: string | null, prompt: string): Promise<string> {
  const text = prompt.trim();
  if (!text) throw new Error("Write something first.");
  const s = session;
  if (!s) throw new Error("You're not connected.");

  let chat = state.chats.find((c) => c.id === chatId);
  if (!chat) chat = { id: `chat${Date.now().toString(36)}${++nextChat}`, title: titleOf(text), messages: [] };
  if (chat.messages.some((m) => m.state === "running")) throw new Error("Wait for the answer first.");
  const history: Turn[] = chat.messages.flatMap((m) =>
    m.answer !== null
      ? [{ role: "user" as const, content: m.prompt }, { role: "assistant" as const, content: splitSuggestions(m.answer).text }]
      : [],
  );
  const context = buildContext(state.memory);
  const id = chat.id;
  const index = chat.messages.length;
  const updated = { ...chat, messages: [...chat.messages, { prompt: text, state: "running" as const, answer: null, error: null, at: Date.now() }] };
  // Most recently used chat first.
  updateChats((chats) => [updated, ...chats.filter((c) => c.id !== id)]);

  const finish = (patch: { state: "done" | "error"; answer?: string | null; error?: string | null }) =>
    updateChats((chats) =>
      chats.map((c) => (c.id === id ? { ...c, messages: c.messages.map((m, i) => (i === index ? { ...m, ...patch } : m)) } : c)),
    );

  void (async () => {
    try {
      let job = await api<Job>("POST", `/v1/hosts/${s.hostId}/ask`, s.token, { prompt: text, history, context });
      let failures = 0;
      while (job.status === "running") {
        try {
          job = await api<Job>("GET", `/v1/hosts/${s.hostId}/jobs/${job.job_id}?wait=${LONG_POLL_SECS}`, s.token);
          failures = 0;
        } catch (e) {
          if (!(e instanceof Unreachable) || ++failures > 5) throw e;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (job.status === "done") finish({ state: "done", answer: job.text ?? "" });
      else finish({ state: "error", error: job.error ?? "No answer." });
    } catch (e) {
      const msg = (e as Error).message;
      finish({ state: "error", error: msg });
      if (msg.startsWith("Your session") || msg.includes("stopped sharing")) endSession(s.generation, "The session ended.");
    }
  })();
  return id;
}

// Give the seat back when the tab closes. If this was only a refresh, boot() takes a new seat;
// if the request didn't get out, the relay frees the seat after 45 seconds without pings.
window.addEventListener("pagehide", () => {
  if (session) void api("DELETE", `/v1/hosts/${session.hostId}/sessions`, session.token, undefined, true).catch(() => {});
});

/** On load: pick up this tab's session after a refresh, or prefill the ID from a shared link (…/#418203977). */
export function boot() {
  void load();
  const fromLink = location.hash.replace(/\D/g, "");
  if (fromLink.length === 9) set({ last_id: fromLink });
  let saved: Saved | null = null;
  try {
    saved = JSON.parse(read(() => sessionStorage, TAB_KEY) ?? "null");
  } catch {
    write(() => sessionStorage, TAB_KEY, null);
  }
  if (!saved || (fromLink.length === 9 && fromLink !== saved.id)) return;
  const s = saved;
  // Same seat if it's still ours; otherwise (the tab's leave request got through) take a new one.
  api<{ online: boolean }>("GET", `/v1/hosts/${s.id}/ping`, s.token)
    .then(() => start(s))
    .catch(() => connect(s.id, s.password, s.name).catch((e) => set({ notice: (e as Error).message })));
}

function setMemory(f: (m: Memory) => Memory) {
  set({ memory: f(state.memory) });
}

async function addMemory(text: string) {
  const t = cleanFact(text);
  if (!t) throw new Error("Write something to remember.");
  if (state.memory.facts.some((f) => f.text.toLowerCase() === t.toLowerCase())) return;
  if (state.memory.facts.length >= MAX_FACTS) throw new Error(`Memory holds up to ${MAX_FACTS} facts. Remove one first.`);
  setMemory((m) => ({ ...m, facts: [...m.facts, { id: `f${Date.now().toString(36)}${m.facts.length}`, text: t, at: Date.now() }] }));
}

async function updateMemory(id: string, text: string) {
  const t = cleanFact(text);
  if (!t) throw new Error("Write something to remember.");
  setMemory((m) => ({ ...m, facts: m.facts.map((f) => (f.id === id ? { ...f, text: t } : f)) }));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const web: ClientBackend = {
  useState: () => useSyncExternalStore(subscribe, () => (loaded ? state : null)),
  connect,
  disconnect,
  clearNotice: async () => set({ notice: null }),
  send,
  deleteChat: async (id) => set({ chats: state.chats.filter((c) => c.id !== id) }),
  addMemory,
  updateMemory,
  deleteMemory: async (id) => setMemory((m) => ({ ...m, facts: m.facts.filter((f) => f.id !== id) })),
  setMemoryEnabled: async (enabled) => setMemory((m) => ({ ...m, enabled })),
  dismissSuggestion: async (text) =>
    setMemory((m) => (m.dismissed.includes(text) ? m : { ...m, dismissed: [...m.dismissed, text].slice(-200) })),
  asksName: true,
};
