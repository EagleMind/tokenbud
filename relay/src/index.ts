// tokenbud relay (and host of the web client, see wrangler.jsonc): passes prompts from people connected to a host on to the host's agent,
// and answers back. Works like TeamViewer: a host has an ID and a password; anyone with
// both can connect, as long as the host has a free seat.
//
// One Durable Object per host. The host app keeps an outbound WebSocket open to it;
// people connect over HTTP. The relay stores only hashes of secrets, and keeps prompts
// just long enough to deliver the answer.

import { DurableObject } from "cloudflare:workers";

export interface Env {
  HOSTS: DurableObjectNamespace<HostRelay>;
}

const MAX_PROMPT_CHARS = 200_000;
const MAX_RESULT_CHARS = 1_000_000;
const MAX_HISTORY_CHARS = 400_000;
const MAX_HISTORY_TURNS = 200;
// The asker's saved memory, passed to the agent as a system prompt.
const MAX_CONTEXT_CHARS = 10_000;
const MAX_NAME_CHARS = 64;
const MAX_SEATS = 50;
const MAX_WAIT_MS = 50_000;
// A session ends when its app stops checking in for this long.
const SESSION_IDLE_MS = 45_000;
const SWEEP_MS = 30_000;
const FINISHED_JOB_RETENTION_MS = 10 * 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;
// Wrong passwords allowed per host per minute before connecting is paused.
const MAX_FAILED_LOGINS = 10;

const HOST_ID_RE = /^\d{9}$/;
const OPEN = ["running"];

type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string };
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (status: number, error: string): Result<never> => ({ ok: false, status, error });

type Turn = { role: "user" | "assistant"; content: string };

type SessionRow = { id: string; name: string; token_hash: string; created_at: number; last_seen: number };
type JobRow = {
  id: string;
  session_id: string;
  prompt: string;
  history: string | null;
  context: string | null;
  status: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

// ---------- helpers ----------

function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomId(): string {
  // 9 digits, never starting with 0, like "418 203 977".
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900_000_000;
  return String(100_000_000 + n);
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const fromResult = <T>(r: Result<T>, okStatus = 200) => (r.ok ? json(r.data, okStatus) : json({ error: r.error }, r.status));

function bearer(request: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  return m ? m[1] : null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim().slice(0, MAX_NAME_CHARS) : "";
  return s || fallback;
}

const jobView = (j: JobRow) => ({ job_id: j.id, status: j.status, text: j.result, error: j.error });

// ---------- Worker entry ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method;

    try {
      if (parts.length === 1 && parts[0] === "health") {
        return json({ service: "tokenbud-relay", ok: true });
      }
      if (parts[0] !== "v1" || parts[1] !== "hosts") return json({ error: "not found" }, 404);

      // POST /v1/hosts -> a new host ID and the secret the host app signs in with.
      if (parts.length === 2 && method === "POST") {
        for (let attempt = 0; attempt < 5; attempt++) {
          const hostId = randomId();
          const secret = "tbh_" + randomToken();
          if (await env.HOSTS.getByName(hostId).init(secret)) {
            return json({ host_id: hostId, host_secret: secret }, 201);
          }
        }
        return json({ error: "could not allocate an ID, try again" }, 503);
      }

      const hostId = parts[2];
      if (!hostId || !HOST_ID_RE.test(hostId)) return json({ error: "No host has that ID." }, 404);
      const stub = env.HOSTS.getByName(hostId);
      const rest = parts.slice(3).join("/");
      const token = bearer(request);

      // The host app's WebSocket (upgrades have to go through fetch).
      if (rest === "connect") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return json({ error: "expected websocket upgrade" }, 426);
        }
        return stub.fetch(request);
      }

      // POST /sessions {password, name} -> start a session (takes a seat).
      if (rest === "sessions" && method === "POST") {
        const body = await readJson(request);
        return fromResult(await stub.openSession(String(body.password ?? ""), cleanName(body.name, "Someone")), 201);
      }

      if (!token) return json({ error: "missing bearer token" }, 401);

      if (rest === "sessions" && method === "DELETE") return fromResult(await stub.closeSession(token));
      if (rest === "ping" && method === "GET") return fromResult(await stub.ping(token));
      if (rest === "ask" && method === "POST") {
        const body = await readJson(request);
        return fromResult(await stub.ask(token, body.prompt, body.history, body.context), 202);
      }
      if (parts.length === 5 && parts[3] === "jobs" && method === "GET") {
        const wait = Number(url.searchParams.get("wait") ?? "0");
        const waitMs = Number.isFinite(wait) ? Math.min(Math.max(wait, 0) * 1000, MAX_WAIT_MS) : 0;
        return fromResult(await stub.getJob(token, parts[4], waitMs));
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error("relay error", err);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ---------- Durable Object: one per host ----------

export class HostRelay extends DurableObject<Env> {
  private sql: SqlStorage;
  // Wakeups for long-polling clients. Safe to lose: clients poll again.
  private waiters = new Map<string, Set<() => void>>();
  private failedLogins: number[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, history TEXT,
        status TEXT NOT NULL, result TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      try {
        this.sql.exec(`ALTER TABLE jobs ADD COLUMN context TEXT`);
      } catch {
        /* already there */
      }
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ----- state -----

  private meta(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray();
    return rows.length ? rows[0].value : null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }

  private hostSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets("host")[0];
  }

  /** Set while the host's reserve has paused sharing: {kind: "limit" | "busy", until: ms | null}. */
  private paused(): { kind: string; until: number | null } | null {
    const raw = this.meta("paused");
    return raw ? JSON.parse(raw) : null;
  }

  private seats(): number {
    return Number(this.meta("seats") ?? "1") || 1;
  }

  private send(ws: WebSocket | undefined, msg: unknown) {
    if (!ws) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.warn("send to host failed", err);
    }
  }

  private wake(jobId: string) {
    const set = this.waiters.get(jobId);
    if (!set) return;
    this.waiters.delete(jobId);
    for (const resolve of set) resolve();
  }

  private sessionList() {
    return this.sql
      .exec<SessionRow>(`SELECT * FROM sessions ORDER BY created_at`)
      .toArray()
      .map((s) => ({
        id: s.id,
        name: s.name,
        since: s.created_at,
        busy: this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE session_id = ? AND status = 'running'`, s.id).one().n > 0,
      }));
  }

  /** Tell the host app who is connected right now. */
  private announce() {
    this.send(this.hostSocket(), { type: "sessions", sessions: this.sessionList() });
  }

  private async session(token: string): Promise<SessionRow | null> {
    const rows = this.sql.exec<SessionRow>(`SELECT * FROM sessions WHERE token_hash = ?`, await sha256(token)).toArray();
    if (!rows.length) return null;
    const s = rows[0];
    if (Date.now() - s.last_seen > SESSION_IDLE_MS) {
      this.endSessions([s.id], "Your session timed out.");
      return null;
    }
    this.sql.exec(`UPDATE sessions SET last_seen = ? WHERE id = ?`, Date.now(), s.id);
    return s;
  }

  /** End sessions: fail their unfinished prompts and free their seats. */
  private endSessions(ids: string[], reason: string) {
    if (!ids.length) return;
    const now = Date.now();
    for (const id of ids) {
      const open = this.sql
        .exec<{ id: string }>(
          `UPDATE jobs SET status = 'error', error = ?, updated_at = ? WHERE session_id = ? AND status = 'running' RETURNING id`,
          reason,
          now,
          id,
        )
        .toArray();
      for (const j of open) {
        this.wake(j.id);
        this.send(this.hostSocket(), { type: "cancel", job_id: j.id });
      }
      this.sql.exec(`DELETE FROM sessions WHERE id = ?`, id);
    }
    this.announce();
  }

  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  private getJobRow(jobId: string): JobRow | null {
    const rows = this.sql.exec<JobRow>(`SELECT * FROM jobs WHERE id = ?`, jobId).toArray();
    return rows.length ? rows[0] : null;
  }

  // ----- RPC -----

  /** Claim this ID for a new host. False if it is taken. */
  async init(secret: string): Promise<boolean> {
    if (this.meta("secret_hash")) return false;
    this.setMeta("secret_hash", await sha256(secret));
    return true;
  }

  async openSession(password: string, name: string): Promise<Result<unknown>> {
    if (!this.meta("secret_hash")) return fail(404, "No host has that ID.");
    const now = Date.now();
    this.failedLogins = this.failedLogins.filter((t) => now - t < 60_000);
    if (this.failedLogins.length >= MAX_FAILED_LOGINS) {
      return fail(429, "Too many wrong passwords. Wait a minute and try again.");
    }
    const stored = this.meta("password_hash");
    if (!stored || !password || stored !== (await sha256(password))) {
      this.failedLogins.push(now);
      return fail(401, "Wrong password.");
    }
    if (!this.hostSocket()) return fail(503, "That host isn't sharing right now.");
    this.sweep();
    const used = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`).one().n;
    if (used >= this.seats()) {
      return fail(409, `All ${this.seats()} seats are taken. Try again when someone leaves.`);
    }
    const id = "s_" + randomToken(8);
    const token = "tbs_" + randomToken();
    this.sql.exec(
      `INSERT INTO sessions (id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`,
      id,
      name,
      await sha256(token),
      now,
      now,
    );
    this.announce();
    await this.ensureAlarm();
    return ok({ session_token: token, host_name: this.meta("name") ?? "" });
  }

  async closeSession(token: string): Promise<Result<unknown>> {
    const s = await this.session(token);
    if (s) this.endSessions([s.id], "You disconnected.");
    return ok({});
  }

  async ping(token: string): Promise<Result<unknown>> {
    const s = await this.session(token);
    if (!s) return fail(401, "Your session has ended.");
    return ok({ online: !!this.hostSocket(), host_name: this.meta("name") ?? "", paused: this.paused() });
  }

  async ask(token: string, prompt: unknown, history: unknown, context?: unknown): Promise<Result<unknown>> {
    const s = await this.session(token);
    if (!s) return fail(401, "Your session has ended.");
    const ws = this.hostSocket();
    if (!ws) return fail(503, "The host stopped sharing.");
    if (this.paused()) return fail(503, "The host paused sharing for now. Try again a little later.");
    if (typeof prompt !== "string" || !prompt.trim()) return fail(400, "prompt is required");
    if (prompt.length > MAX_PROMPT_CHARS) return fail(413, `prompt exceeds ${MAX_PROMPT_CHARS} chars`);

    const turns: Turn[] = [];
    if (history != null) {
      if (!Array.isArray(history) || history.length > MAX_HISTORY_TURNS) return fail(400, "history is too long");
      let chars = 0;
      for (const t of history) {
        if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string") {
          return fail(400, "each history turn needs a role and content");
        }
        chars += t.content.length;
        turns.push({ role: t.role, content: t.content });
      }
      if (chars > MAX_HISTORY_CHARS) return fail(413, "conversation is too long; start a new chat");
    }
    if (context != null && (typeof context !== "string" || context.length > MAX_CONTEXT_CHARS)) {
      return fail(413, `memory must be text up to ${MAX_CONTEXT_CHARS} chars`);
    }
    const ctxText = typeof context === "string" && context.trim() ? context : null;
    // One prompt at a time per person, so seats cap how many run at once.
    const running = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE session_id = ? AND status = 'running'`, s.id).one().n;
    if (running > 0) return fail(409, "Wait for the current answer first.");

    const now = Date.now();
    const job: JobRow = {
      id: "j_" + randomToken(9),
      session_id: s.id,
      prompt,
      history: turns.length ? JSON.stringify(turns) : null,
      context: ctxText,
      status: "running",
      result: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    this.sql.exec(
      `INSERT INTO jobs (id, session_id, prompt, history, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id,
      job.session_id,
      job.prompt,
      job.history,
      job.context,
      job.status,
      now,
      now,
    );
    this.send(ws, { type: "job", job_id: job.id, session_id: s.id, name: s.name, prompt, history: turns, context: ctxText });
    this.announce();
    return ok(jobView(job));
  }

  async getJob(token: string, jobId: string, waitMs: number): Promise<Result<unknown>> {
    const s = await this.session(token);
    if (!s) return fail(401, "Your session has ended.");
    let job = this.getJobRow(jobId);
    if (!job || job.session_id !== s.id) return fail(404, "job not found");
    if (OPEN.includes(job.status) && waitMs > 0) {
      await new Promise<void>((resolve) => {
        let set = this.waiters.get(jobId);
        if (!set) this.waiters.set(jobId, (set = new Set()));
        const done = () => {
          clearTimeout(timer);
          set!.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        set.add(done);
      });
      // Long polls count as activity too.
      this.sql.exec(`UPDATE sessions SET last_seen = ? WHERE id = ?`, Date.now(), s.id);
      job = this.getJobRow(jobId);
      if (!job) return fail(404, "job not found");
    }
    return ok(jobView(job));
  }

  // ----- the host app's WebSocket -----

  async fetch(request: Request): Promise<Response> {
    const token = bearer(request);
    const stored = this.meta("secret_hash");
    if (!token || !stored || stored !== (await sha256(token))) return json({ error: "invalid host secret" }, 401);

    for (const old of this.ctx.getWebSockets("host")) {
      try {
        old.close(4000, "replaced by a newer connection");
      } catch {}
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["host"]);
    // A new connection starts unpaused; the host re-sends its pause state right after "config".
    this.sql.exec(`DELETE FROM meta WHERE key = 'paused'`);
    // The host sends its password and seat count first ("config"); until then nobody can connect.
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const now = Date.now();

    if (msg.type === "config") {
      if (typeof msg.password === "string" && msg.password.length >= 4) {
        const hash = await sha256(msg.password);
        const changed = this.meta("password_hash") !== hash;
        this.setMeta("password_hash", hash);
        // A new password ends everyone's session, like TeamViewer.
        if (changed) this.endSessions(this.sql.exec<{ id: string }>(`SELECT id FROM sessions`).toArray().map((r) => r.id), "The host changed the password.");
      }
      if (typeof msg.seats === "number") this.setMeta("seats", String(Math.min(Math.max(Math.floor(msg.seats), 1), MAX_SEATS)));
      if (typeof msg.name === "string") this.setMeta("name", msg.name.slice(0, MAX_NAME_CHARS));
      this.announce();
      await this.ensureAlarm();
      return;
    }

    if (msg.type === "pause") {
      const p = msg.paused as { kind?: unknown; until?: unknown } | null;
      if (p && (p.kind === "limit" || p.kind === "busy")) {
        this.setMeta("paused", JSON.stringify({ kind: p.kind, until: typeof p.until === "number" ? p.until : null }));
      } else {
        this.sql.exec(`DELETE FROM meta WHERE key = 'paused'`);
      }
      return;
    }

    if (msg.type === "kick" && typeof msg.session_id === "string") {
      this.endSessions([msg.session_id], "The host disconnected you.");
      return;
    }

    if (msg.type === "result" && typeof msg.job_id === "string") {
      const status = msg.status === "done" ? "done" : "error";
      const text = typeof msg.text === "string" ? msg.text.slice(0, MAX_RESULT_CHARS) : null;
      const error = typeof msg.error === "string" ? msg.error.slice(0, 2000) : null;
      this.sql.exec(
        `UPDATE jobs SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
        status,
        text,
        error,
        now,
        msg.job_id,
      );
      this.wake(msg.job_id);
      this.announce();
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {}
    // The host stopped sharing: everyone is disconnected.
    if (!this.ctx.getWebSockets("host").some((w) => w !== ws)) {
      this.endSessions(this.sql.exec<{ id: string }>(`SELECT id FROM sessions`).toArray().map((r) => r.id), "The host stopped sharing.");
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.warn("host websocket error", error);
  }

  // ----- housekeeping -----

  private sweep() {
    const now = Date.now();
    const idle = this.sql
      .exec<{ id: string }>(`SELECT id FROM sessions WHERE last_seen < ?`, now - SESSION_IDLE_MS)
      .toArray()
      .map((r) => r.id);
    this.endSessions(idle, "Your session timed out.");
    const stale = this.sql
      .exec<{ id: string }>(
        `UPDATE jobs SET status = 'error', error = 'the host did not answer in time', updated_at = ?
         WHERE status = 'running' AND created_at < ? RETURNING id`,
        now,
        now - JOB_TTL_MS,
      )
      .toArray();
    for (const j of stale) this.wake(j.id);
    this.sql.exec(`DELETE FROM jobs WHERE status != 'running' AND updated_at < ?`, now - FINISHED_JOB_RETENTION_MS);
  }

  async alarm() {
    this.sweep();
    const left =
      this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`).one().n +
      this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs`).one().n;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }
}
