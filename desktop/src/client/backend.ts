import { createContext, useContext } from "react";

// The chat UI runs in two places: the desktop app (Rust backend, Tauri commands) and the
// browser (src/web/store.ts, talking to the relay directly). Both provide this interface.

export interface Message {
  prompt: string;
  state: "running" | "done" | "error";
  answer: string | null;
  error: string | null;
  at: number;
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
}

export interface Fact {
  id: string;
  text: string;
  at: number;
}

/** Local-first memory: facts about you, kept on this device and sent with each prompt when enabled. */
export interface Memory {
  enabled: boolean;
  facts: Fact[];
  /** Suggestions answered with "Not now". */
  dismissed: string[];
}

/** The host's reserve paused sharing: "limit" (hourly limit, resumes at `until`) or "busy" (host is using Claude). */
export interface Paused {
  kind: "limit" | "busy";
  until: number | null;
}

export interface ClientState {
  connection: { host_id: string; host_name: string; online: boolean; paused?: Paused | null } | null;
  notice: string | null;
  last_id: string;
  chats: Chat[];
  memory: Memory;
}

export interface ClientBackend {
  /** A hook returning the current state (null while loading). */
  useState(): ClientState | null;
  connect(id: string, password: string, name?: string): Promise<void>;
  disconnect(): Promise<void>;
  clearNotice(): Promise<void>;
  /** Send in a chat (null starts a new one); resolves to the chat's id. */
  send(chatId: string | null, prompt: string): Promise<string>;
  deleteChat(chatId: string): Promise<void>;
  addMemory(text: string): Promise<void>;
  updateMemory(id: string, text: string): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  setMemoryEnabled(enabled: boolean): Promise<void>;
  dismissSuggestion(text: string): Promise<void>;
  /** The browser has no user name to borrow, so it asks for one. */
  asksName: boolean;
}

export const BackendContext = createContext<ClientBackend | null>(null);

export function useBackend(): ClientBackend {
  const b = useContext(BackendContext);
  if (!b) throw new Error("no client backend");
  return b;
}

// ----- memory and chat rules (shared by the UI and the web store) -----
// These mirror apps/tokenbud-client/src/memory.rs; tests/fixtures/memory.json keeps them in step.

export const MAX_FACTS = 50;
export const MAX_FACT_CHARS = 300;
export const MAX_CHATS = 100;
export const MAX_DISMISSED = 200;
const TITLE_CHARS = 48;

const REMEMBER_INSTRUCTION =
  "If they share a lasting fact about themselves or a preference worth remembering in future conversations, " +
  'end your reply with <remember>one short fact, like "Prefers short answers"</remember> (at most two). ' +
  "Otherwise don't add it, and never mention these tags.";

/** The system prompt that carries your memory to the host's agent (null when memory is off). */
export function buildContext(memory: Memory): string | null {
  if (!memory.enabled) return null;
  let out = "";
  if (memory.facts.length) {
    out += "What you know about the person asking, from their own saved notes:\n";
    for (const f of memory.facts) out += `- ${f.text}\n`;
    out += "\n";
  }
  return out + REMEMBER_INSTRUCTION;
}

const REMEMBER_RE = /<remember>([\s\S]*?)(?:<\/remember>|$)/g;

/** An answer without its <remember> tags, and the facts the agent suggested. */
export function splitSuggestions(answer: string): { text: string; suggestions: string[] } {
  const suggestions = [...answer.matchAll(REMEMBER_RE)].map((m) => cleanFact(m[1])).filter(Boolean);
  return { text: answer.replace(REMEMBER_RE, "").trim(), suggestions };
}

/** Characters, not UTF-16 units: never splits an emoji. */
const takeChars = (s: string, n: number) => Array.from(s).slice(0, n).join("");

/** One line, trimmed, at most MAX_FACT_CHARS characters ("" when there's nothing). */
export function cleanFact(text: string): string {
  return takeChars(text.replace(/\s+/g, " ").trim(), MAX_FACT_CHARS);
}

/** A chat's title: the first non-empty line of its first prompt, cut by characters. */
export function titleOf(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.trim())?.trim() ?? "New chat";
  return Array.from(line).length > TITLE_CHARS ? takeChars(line, TITLE_CHARS) + "…" : line;
}

export type Turn = { role: "user" | "assistant"; content: string };

/** The chat so far for the host: answered exchanges only, without memory suggestions. */
export function buildHistory(messages: Message[]): Turn[] {
  return messages.flatMap((m) =>
    m.state === "done" && m.answer !== null
      ? [
          { role: "user" as const, content: m.prompt },
          { role: "assistant" as const, content: splitSuggestions(m.answer).text },
        ]
      : [],
  );
}

// ----- saved data: checked as it's loaded, so old or damaged data can't crash the UI -----

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function normalizeMemory(v: unknown): Memory {
  if (!isObject(v)) return { enabled: true, facts: [], dismissed: [] };
  const facts = (Array.isArray(v.facts) ? v.facts : [])
    .filter(isObject)
    .map((f) => ({ id: str(f.id), text: cleanFact(str(f.text)), at: num(f.at) }))
    .filter((f) => f.id && f.text)
    .slice(0, MAX_FACTS);
  const dismissed = (Array.isArray(v.dismissed) ? v.dismissed : []).filter((d): d is string => typeof d === "string").slice(-MAX_DISMISSED);
  return { enabled: v.enabled !== false, facts, dismissed };
}

const STATES = new Set(["running", "done", "error"]);

export function normalizeChats(v: unknown): Chat[] {
  return (Array.isArray(v) ? v : [])
    .filter(isObject)
    .map((c) => ({
      id: str(c.id),
      title: str(c.title, "Chat"),
      messages: (Array.isArray(c.messages) ? c.messages : []).filter(isObject).map(
        (m): Message => ({
          prompt: str(m.prompt),
          state: STATES.has(str(m.state)) ? (m.state as Message["state"]) : "error",
          answer: typeof m.answer === "string" ? m.answer : null,
          error: typeof m.error === "string" ? m.error : null,
          at: num(m.at),
        }),
      ),
    }))
    .filter((c) => c.id)
    .slice(0, MAX_CHATS);
}
