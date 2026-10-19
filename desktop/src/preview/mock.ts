// Browser preview: stands in for the Tauri backend with sample data, so the UI can be
// reviewed in a normal browser (`npm run preview:ui`, then open /preview.html).
// Use the switch at the top for host and client mode; ?connect=1 shows the connect screen.
// Never part of the desktop builds.

import type { ClientState } from "../client/backend";
import type { HostState } from "../host/types";

const now = Date.now();
const min = 60_000;
const params = new URLSearchParams(location.search);

const host = {
  status: "ready",
  detail: null,
  host_id: "418203977",
  password: "k7m2pqxa",
  seats: 3,
  engine: (params.get("engine") ?? "local") as HostState["engine"],
  claude_code_allowed: true,
  local: { url: "", model: "" },
  provider: "openai",
  providers: (
    [
      ["anthropic", "Anthropic", "platform.claude.com", "claude-opus-5-5", true],
      ["openai", "OpenAI", "platform.openai.com/api-keys", "", true],
      ["google", "Google Gemini", "aistudio.google.com/apikey", "", false],
      ["mistral", "Mistral", "console.mistral.ai", "", false],
      ["groq", "Groq", "console.groq.com/keys", "", false],
      ["deepseek", "DeepSeek", "platform.deepseek.com/api_keys", "", false],
      ["xai", "xAI", "console.x.ai", "", false],
      ["openrouter", "OpenRouter", "openrouter.ai/keys", "", false],
      ["custom", "Custom", "", "", false],
    ] as const
  ).map(([id, name, key_url, default_model, has_key]) => ({ id, name, key_url, default_model, has_key, model: "" })),
  custom_url: "",
  models: ["qwen3:8b", "llama3.2:3b", "gemma3:12b"],
  engine_check: { ok: true, text: "Ollama is running, answering with qwen3:8b." },
  sessions: [
    { id: "s1", name: "Sam Rivera", since: now - 12 * min, busy: true },
    { id: "s2", name: "Jo", since: now - 3 * min, busy: false },
  ],
  web_url: "https://tokenbud-relay.example.workers.dev",
  reserve: {
    max_per_hour: 30,
    pause_while_busy: true,
    lent_hour: 12,
    lent_day: 47,
    cost_day: 1.26,
    paused:
      params.get("paused") === "busy"
        ? { kind: "busy", until: null }
        : params.get("paused") === "limit"
          ? { kind: "limit", until: now + 18 * min }
          : null,
  },
} satisfies HostState;

const client = {
  connection:
    params.get("connect") === "1"
      ? null
      : {
          host_id: "418203977",
          host_name: "Maya",
          online: true,
          paused: params.get("paused") === "limit" ? { kind: "limit", until: now + 18 * min } : null,
        },
  notice: params.get("connect") === "1" ? "The host changed the password." : null,
  last_id: "418203977",
  memory: {
    enabled: true,
    facts: [
      { id: "f1", text: "Writes Rust and TypeScript", at: now - 86400_000 },
      { id: "f2", text: "Prefers short answers with code", at: now - 3600_000 },
    ],
    dismissed: [],
  },
  chats: [
    {
      id: "chat2",
      title: "Can you sanity-check this plan?",
      messages: [
        {
          prompt: "Can you sanity-check this plan?\n\n1. Move the cron job to Workers\n2. Keep the queue in a Durable Object\n3. Add retry_after handling\n\nIs step 3 overkill?",
          state: "done",
          answer: "Not overkill. **Step 3 is the one that saves you** when the upstream API rate-limits you.\n\n- Read `retry-after` on 429 and 503\n- Cap the wait (30s is plenty)\n- Store the next attempt time in the Durable Object\n\n```ts\nconst wait = Number(res.headers.get(\"retry-after\") ?? 2);\n```\n<remember>Is moving a cron job to Cloudflare Workers</remember>",
          error: null,
          at: now - 4 * min,
        },
        { prompt: "And how would you test it?", state: "running", answer: null, error: null, at: now - 0.2 * min },
      ],
    },
    { id: "chat1", title: "Recommend a book on sourdough baking", messages: [] },
  ],
} satisfies ClientState;

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => {
    const id = Math.floor(Math.random() * 1e9);
    (window as unknown as Record<string, unknown>)[`_${id}`] = cb;
    return id;
  },
  invoke: async (cmd: string) => {
    if (cmd.startsWith("plugin:event|")) return 0;
    if (cmd === "host_state") return host;
    if (cmd === "client_state") return client;
    if (cmd === "is_sharing") return true;
    if (cmd === "send") return "chat9";
    if (cmd === "relay_state")
      return { url: "https://tokenbud-relay.example.workers.dev", default_url: "https://tokenbud-relay.example.workers.dev", custom: false, from_env: false };
    console.info("[preview] ignored command", cmd);
    return null;
  },
};

// Unsubscribing from events goes through here.
(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

await import("../app/main");

// ?steps=host,settings:model,chat — click through to a screen (used for README screenshots).
const steps = (params.get("steps") ?? "").split(",").filter(Boolean);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text));
await pause(400);
for (const step of steps) {
  const [what, arg] = step.split(":");
  if (what === "host") button("Share my agent")?.click();
  if (what === "client") button("Connect to an agent")?.click();
  if (what === "settings") {
    document.querySelector<HTMLButtonElement>("button[aria-label=Settings]")?.click();
    await pause(150);
    if (arg) button(arg[0].toUpperCase() + arg.slice(1))?.click();
  }
  if (what === "chat") document.querySelector<HTMLButtonElement>("nav button")?.click();
  if (what === "memory") button("Memory")?.click();
  await pause(250);
}
export {};
