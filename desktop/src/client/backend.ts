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

// ----- memory helpers (shared by the UI and the web store) -----

export const MAX_FACTS = 50;
export const MAX_FACT_CHARS = 300;
export const MAX_CHATS = 100;

const REMEMBER_INSTRUCTION =
  "If they share a lasting fact about themselves or a preference worth remembering in future conversations, " +
  'end your reply with <remember>one short fact, like "Prefers short answers"</remember> (at most two). ' +
  "Otherwise don't add it, and never mention these tags.";

/** The system prompt that carries your memory to the host's agent. Mirrors `Memory::context` in apps/desktop/src/client.rs. */
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
  return { text: answer.replace(REMEMBER_RE, "").trimEnd(), suggestions };
}

export function cleanFact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_CHARS);
}
