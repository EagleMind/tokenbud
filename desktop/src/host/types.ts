// Mirrors HostView in apps/desktop/src/host.rs.

export type Engine = "local" | "provider" | "claude_code";

export interface Session {
  id: string;
  name: string;
  since: number;
  busy: boolean;
}

export type { Paused } from "@/client/backend";
import type { Paused } from "@/client/backend";

export interface Reserve {
  max_per_hour: number;
  pause_while_busy: boolean;
  lent_hour: number;
  lent_day: number;
  cost_day: number;
  paused: Paused | null;
}

export interface Provider {
  id: string;
  name: string;
  /** Where to get a key, e.g. "platform.openai.com/api-keys" ("" for custom). */
  key_url: string;
  default_model: string;
  has_key: boolean;
  /** Your pick ("" = its default, or the first it lists). */
  model: string;
}

export interface HostState {
  status: "stopped" | "connecting" | "ready" | "retrying";
  detail: string | null;
  host_id: string | null;
  password: string;
  seats: number;
  engine: Engine;
  /** Development builds only. */
  claude_code_allowed: boolean;
  local: { url: string; model: string };
  provider: string;
  providers: Provider[];
  custom_url: string;
  /** Models the current local server or provider offers. */
  models: string[];
  engine_check: { ok: boolean; text: string } | null;
  sessions: Session[];
  web_url: string;
  reserve: Reserve;
}

export type SettingsSection = "model" | "reserve" | "relay" | "appearance";
