// The web client's backend: talks to the relay straight from the browser (same origin, since the
// relay Worker serves this page). Mirrors apps/desktop/src/client.rs. Chats and memory are
// local-first: kept in this browser's IndexedDB.

import { useSyncExternalStore } from "react";

import {
  buildContext,
  buildHistory,
  type Chat,
  cleanFact,
  type ClientBackend,
  type ClientState,
  MAX_CHATS,
  MAX_DISMISSED,
  MAX_FACTS,
  type Memory,
  type Message,
  normalizeChats,
  normalizeMemory,
  type Paused,
  titleOf,
} from "@/client/backend";
import { errorMessage } from "@/lib/errors";
import { api, isRelayError } from "./api";
import * as idb from "./idb";

const PING_EVERY_MS = 15_000;
const LONG_POLL_SECS = 25;
const MAX_POLL_FAILURES = 5;
const RETRY_DELAY_MS = 2_000;
// Per tab: lets a refresh pick the same seat back up. Only the seat's token is kept, never the
// password. Gone when the tab closes (the relay then frees the seat within 45 seconds).
const TAB_KEY = "tokenbud-session";
const LAST_ID_KEY = "tokenbud-last-id";
// Older versions kept chats per tab here; they move to IndexedDB once.
const OLD_CHATS_KEY = "tokenbud-chats";

type Job = { job_id: string; status: "running" | "done" | "error"; text: string | null; error: string | null };
/** What a tab remembers about its seat. */
type Saved = { id: string; token: string; host_name: string };

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

function readSaved(): Saved | null {
  try {
    const v: unknown = JSON.parse(read(() => sessionStorage, TAB_KEY) ?? "null");
    if (v && typeof v === "object") {
      const { id, token, host_name } = v as Record<string, unknown>;
      if (typeof id === "string" && typeof token === "string") {
        return { id, token, host_name: typeof host_name === "string" ? host_name : "" };
      }
    }
  } catch {
    /* unreadable: start fresh */
  }
  write(() => sessionStorage, TAB_KEY, null);
  return null;
}

/** Answers still coming won't arrive any more. */
const failRunning = (chats: Chat[], why: string): Chat[] =>
  chats.map((c) =>
    c.messages.some((m) => m.state === "running")
      ? { ...c, messages: c.messages.map((m): Message => (m.state === "running" ? { ...m, state: "error", error: why } : m)) }
      : c,
  );

let state: ClientState = {
  connection: null,
  notice: null,
  last_id: read(() => localStorage, LAST_ID_KEY) ?? "",
  chats: [],
  memory: normalizeMemory(null),
};
let loaded = false;
let session: { hostId: string; token: string; generation: number; stop: AbortController } | null = null;
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

function updateChats(f: (chats: Chat[]) => Chat[]) {
  set({ chats: f(state.chats) });
}

/** Read chats and memory from IndexedDB (and carry over chats from older per-tab storage). */
async function load() {
  let chats = normalizeChats(await idb.get("chats"));
  const old = read(() => sessionStorage, OLD_CHATS_KEY);
  if (old) {
    try {
      const known = new Set(chats.map((c) => c.id));
      chats = [...normalizeChats(JSON.parse(old)).filter((c) => !known.has(c.id)), ...chats];
    } catch {
      /* unreadable: skip it */
    }
    write(() => sessionStorage, OLD_CHATS_KEY, null);
  }
  const memory = normalizeMemory(await idb.get("memory"));
  loaded = true;
  set({ chats: failRunning(chats, "The page closed before the answer arrived."), memory });
}

function endSession(gen: number, why: string | null) {
  if (!session || session.generation !== gen) return;
  session.stop.abort();
  session = null;
  generation++;
  write(() => sessionStorage, TAB_KEY, null);
  set({ connection: null, notice: why, chats: failRunning(state.chats, "Disconnected before the answer arrived.") });
}

const leave = (s: { hostId: string; token: string }) => api("DELETE", `/v1/hosts/${s.hostId}/sessions`, { token: s.token }).catch(() => {});

async function connect(id: string, password: string, name = "") {
  const hostId = id.replace(/\D/g, "");
  if (hostId.length !== 9) throw new Error("An ID is 9 digits, like 418 203 977.");
  const r = await api<{ session_token: string; host_name: string }>("POST", `/v1/hosts/${hostId}/sessions`, {
    body: { password: password.trim(), name: name || "Someone" },
  });
  if (session) void leave(session);
  start({ id: hostId, token: r.session_token, host_name: r.host_name });
}

/** Use a seat: remember it for this tab, and keep it with regular pings. */
function start(saved: Saved) {
  session?.stop.abort();
  const gen = ++generation;
  const stop = new AbortController();
  session = { hostId: saved.id, token: saved.token, generation: gen, stop };
  write(() => localStorage, LAST_ID_KEY, saved.id);
  write(() => sessionStorage, TAB_KEY, JSON.stringify(saved));
  set({ connection: { host_id: saved.id, host_name: saved.host_name, online: true }, notice: null, last_id: saved.id });

  const timer = setInterval(async () => {
    if (!session || session.generation !== gen) return clearInterval(timer);
    try {
      const p = await api<{ online: boolean; paused?: Paused | null }>("GET", `/v1/hosts/${saved.id}/ping`, {
        token: saved.token,
        signal: stop.signal,
      });
      if (state.connection) set({ connection: { ...state.connection, online: p.online, paused: p.paused ?? null } });
    } catch (e) {
      if (stop.signal.aborted) return;
      if (isRelayError(e) && e.sessionEnded) {
        clearInterval(timer);
        endSession(gen, e.message);
      } else if (state.connection) {
        // A network or relay hiccup: show it, keep the seat, try again next time.
        set({ connection: { ...state.connection, online: false } });
      }
    }
  }, PING_EVERY_MS);
  stop.signal.addEventListener("abort", () => clearInterval(timer));
}

async function disconnect() {
  if (session) {
    void leave(session);
    endSession(session.generation, null);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(chatId: string | null, prompt: string): Promise<string> {
  const text = prompt.trim();
  if (!text) throw new Error("Write something first.");
  const s = session;
  if (!s) throw new Error("You're not connected.");

  const chat = state.chats.find((c) => c.id === chatId) ?? {
    id: `chat${Date.now().toString(36)}${++nextChat}`,
    title: titleOf(text),
    messages: [],
  };
  if (chat.messages.some((m) => m.state === "running")) throw new Error("Wait for the answer first.");
  const history = buildHistory(chat.messages);
  const context = buildContext(state.memory);
  const id = chat.id;
  const index = chat.messages.length;
  const updated: Chat = { ...chat, messages: [...chat.messages, { prompt: text, state: "running", answer: null, error: null, at: Date.now() }] };
  // Most recently used chat first.
  updateChats((chats) => [updated, ...chats.filter((c) => c.id !== id)]);

  const finish = (patch: Pick<Message, "state"> & Partial<Pick<Message, "answer" | "error">>) =>
    updateChats((chats) => chats.map((c) => (c.id === id ? { ...c, messages: c.messages.map((m, i) => (i === index ? { ...m, ...patch } : m)) } : c)));

  void (async () => {
    try {
      const opts = { token: s.token, signal: s.stop.signal };
      let job = await api<Job>("POST", `/v1/hosts/${s.hostId}/ask`, { ...opts, body: { prompt: text, history, context } });
      let failures = 0;
      while (job.status === "running") {
        try {
          job = await api<Job>("GET", `/v1/hosts/${s.hostId}/jobs/${job.job_id}?wait=${LONG_POLL_SECS}`, opts);
          failures = 0;
        } catch (e) {
          if (!(isRelayError(e) && e.transient) || ++failures > MAX_POLL_FAILURES) throw e;
          await sleep(RETRY_DELAY_MS);
        }
      }
      if (job.status === "done") finish({ state: "done", answer: job.text ?? "" });
      else finish({ state: "error", error: job.error ?? "No answer." });
    } catch (e) {
      if (s.stop.signal.aborted) return; // disconnected: endSession already marked it
      finish({ state: "error", error: errorMessage(e) });
      if (isRelayError(e) && e.sessionEnded) endSession(s.generation, "The session ended.");
    }
  })();
  return id;
}

/** On load: pick up this tab's seat after a refresh, or prefill the ID from a shared link (…/#418203977). */
export function boot() {
  void load();
  const fromLink = location.hash.replace(/\D/g, "");
  if (fromLink.length === 9) set({ last_id: fromLink });
  const saved = readSaved();
  if (!saved || (fromLink.length === 9 && fromLink !== saved.id)) return;
  // Same seat if it's still ours; if it ended meanwhile, ask for the password again (the ID is filled in).
  api<{ online: boolean }>("GET", `/v1/hosts/${saved.id}/ping`, { token: saved.token })
    .then(() => start(saved))
    .catch((e: unknown) => {
      write(() => sessionStorage, TAB_KEY, null);
      const notice = isRelayError(e) && e.sessionEnded ? "Your session ended. Enter the password to connect again." : errorMessage(e);
      set({ last_id: saved.id, notice });
    });
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
    setMemory((m) => (m.dismissed.includes(text) ? m : { ...m, dismissed: [...m.dismissed, cleanFact(text)].slice(-MAX_DISMISSED) })),
  asksName: true,
};

/** The current state, for tests. */
export const snapshot = () => state;

/** For tests: forget everything this module holds. */
export function resetForTests() {
  session?.stop.abort();
  session = null;
  generation = 0;
  loaded = true;
  state = { connection: null, notice: null, last_id: "", chats: [], memory: normalizeMemory(null) };
}
