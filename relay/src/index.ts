// tokenbud relay (and host of the web client, see wrangler.jsonc): passes prompts from people
// connected to a host on to the host's agent, and answers back. A host has an ID and a password;
// anyone with both can connect, as long as the host has a free seat.
//
// One Durable Object per host. The host app keeps an outbound WebSocket open to it; people
// connect over HTTP. The relay stores only hashes of secrets, and keeps prompts just long enough
// to deliver the answer. Every error carries a machine-readable `code` (see util.ts).

import { DurableObject } from "cloudflare:workers";

import {
  activePause,
  cleanName,
  equalSecret,
  errorResponse,
  fail,
  fromResult,
  hashPassword,
  isLegacyHash,
  json,
  ok,
  randomHostId,
  randomToken,
  sha256,
  truncateBytes,
  utf8Bytes,
  verifyPassword,
  type Paused,
  type Result,
} from "./util";

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  HOSTS: DurableObjectNamespace<HostRelay>;
  /** Per-IP limits (wrangler.jsonc "ratelimits"); absent in tests and older deployments. */
  REGISTER_LIMIT?: RateLimit;
  SESSION_LIMIT?: RateLimit;
}

// Sizes are UTF-8 bytes: what storage and WebSocket messages count.
const MAX_BODY_BYTES = 1_500_000;
const MAX_PROMPT_BYTES = 200_000;
const MAX_HISTORY_BYTES = 400_000;
const MAX_HISTORY_TURNS = 200;
const MAX_CONTEXT_BYTES = 10_000; // the asker's saved memory, passed to the agent as a system prompt
const MAX_RESULT_BYTES = 1_000_000;
const MAX_ERROR_BYTES = 2_000;
const MAX_NAME_CHARS = 64;
const MAX_SEATS = 50;
const MIN_PASSWORD_CHARS = 8;
const MAX_WAIT_MS = 50_000;
// A session ends when its app stops checking in for this long.
const SESSION_IDLE_MS = 45_000;
// Checking in more often than this doesn't need writing down.
const LAST_SEEN_RESOLUTION_MS = 10_000;
const SWEEP_MS = 30_000;
const FINISHED_JOB_RETENTION_MS = 10 * 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;
// Wrong passwords allowed per caller (IP) per minute; other callers are never blocked.
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 60_000;
// A host that hasn't connected for this long, with nothing pending, is deleted.
const STALE_HOST_MS = 30 * 24 * 60 * 60 * 1000;
const REGISTER_ATTEMPTS = 5;

const HOST_ID_RE = /^\d{9}$/;

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

// ---------- Worker entry ----------

function bearer(request: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  return m ? m[1] : null;
}

const callerIp = (request: Request) => request.headers.get("cf-connecting-ip") ?? "unknown";

/** The JSON body as an object, refusing anything over MAX_BODY_BYTES before parsing it. */
async function readJson(request: Request): Promise<Record<string, unknown> | "too_large"> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return "too_large";
  const text = await request.text();
  if (utf8Bytes(text) > MAX_BODY_BYTES) return "too_large";
  try {
    const body: unknown = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const tooLarge = () => errorResponse(413, "too_large", "That's too large to send.");
const rateLimited = () => errorResponse(429, "rate_limited", "Too many attempts. Wait a minute and try again.");

async function allowed(limit: RateLimit | undefined, key: string): Promise<boolean> {
  return limit ? (await limit.limit({ key })).success : true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method;

    try {
      if (parts.length === 1 && parts[0] === "health") {
        return json({ service: "tokenbud-relay", ok: true });
      }
      if (parts[0] !== "v1" || parts[1] !== "hosts") return errorResponse(404, "not_found", "not found");

      // POST /v1/hosts -> a new host ID and the secret the host app signs in with.
      if (parts.length === 2 && method === "POST") {
        if (!(await allowed(env.REGISTER_LIMIT, `register:${callerIp(request)}`))) return rateLimited();
        for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
          const hostId = randomHostId();
          const secret = "tbh_" + randomToken();
          if (await env.HOSTS.getByName(hostId).init(secret)) {
            return json({ host_id: hostId, host_secret: secret }, 201);
          }
        }
        return errorResponse(503, "not_sharing", "Couldn't allocate an ID. Try again.");
      }

      const hostId = parts[2] ?? "";
      const rest = parts.slice(3).join("/");

      // POST /sessions {password, name} -> start a session (takes a seat). An ID that isn't a
      // host gets the same answer as a wrong password, so IDs can't be probed.
      if (rest === "sessions" && method === "POST") {
        if (!(await allowed(env.SESSION_LIMIT, `session:${callerIp(request)}`))) return rateLimited();
        if (!HOST_ID_RE.test(hostId)) return errorResponse(401, "wrong_password", "Wrong ID or password.");
        const body = await readJson(request);
        if (body === "too_large") return tooLarge();
        const name = cleanName(body.name, "Someone", MAX_NAME_CHARS);
        return fromResult(await env.HOSTS.getByName(hostId).openSession(String(body.password ?? ""), name, callerIp(request)), 201);
      }

      if (!HOST_ID_RE.test(hostId)) return errorResponse(404, "not_found", "not found");
      const stub = env.HOSTS.getByName(hostId);

      // The host app's WebSocket (upgrades have to go through fetch).
      if (rest === "connect") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return errorResponse(426, "bad_request", "expected websocket upgrade");
        }
        return stub.fetch(request);
      }

      const token = bearer(request);
      if (!token) return errorResponse(401, "session_ended", "Your session has ended.");

      if (rest === "sessions" && method === "DELETE") return fromResult(await stub.closeSession(token));
      if (rest === "ping" && method === "GET") return fromResult(await stub.ping(token));
      if (rest === "ask" && method === "POST") {
        const body = await readJson(request);
        if (body === "too_large") return tooLarge();
        return fromResult(await stub.ask(token, body.prompt, body.history, body.context), 202);
      }
      if (parts.length === 5 && parts[3] === "jobs" && method === "GET") {
        const wait = Number(url.searchParams.get("wait") ?? "0");
        const waitMs = Number.isFinite(wait) ? Math.min(Math.max(wait, 0) * 1000, MAX_WAIT_MS) : 0;
        return fromResult(await stub.getJob(token, parts[4], waitMs));
      }
      return errorResponse(404, "not_found", "not found");
    } catch (err) {
      console.error("relay error", err);
      return errorResponse(500, "not_sharing", "Something went wrong on the relay. Try again.");
    }
  },
} satisfies ExportedHandler<Env>;

// ---------- Durable Object: one per host ----------

export class HostRelay extends DurableObject<Env> {
  private sql: SqlStorage;
  // Wakeups for long-polling clients. Safe to lose: clients poll again.
  private waiters = new Map<string, Set<() => void>>();
  /** Only a claimed ID has tables. Probing an unclaimed ID writes nothing. */
  private registered = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.registered = this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray().length > 0;
      if (this.registered) this.migrate();
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Create or update the schema. Idempotent: run on every start of a claimed ID. */
  private migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, history TEXT, context TEXT,
      status TEXT NOT NULL, result TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    // Objects created before `context` existed.
    const columns = this.sql.exec<{ name: string }>(`PRAGMA table_info(jobs)`).toArray().map((c) => c.name);
    if (!columns.includes("context")) this.sql.exec(`ALTER TABLE jobs ADD COLUMN context TEXT`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS failed_logins (ip TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS jobs_session_status ON jobs (session_id, status)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS jobs_status_updated ON jobs (status, updated_at)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS failed_logins_ip_at ON failed_logins (ip, at)`);
  }

  // ----- state -----

  private meta(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray();
    return rows.length ? rows[0].value : null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }

  private deleteMeta(key: string) {
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, key);
  }

  /** The host's open connection. A replaced socket can linger in the list while it closes. */
  private hostSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets("host").find((ws) => ws.readyState === WebSocket.OPEN);
  }

  /** Set while the host's reserve has paused sharing (and its `until` hasn't passed). */
  private paused(): Paused | null {
    const raw = this.meta("paused");
    return raw ? activePause(JSON.parse(raw) as Paused, Date.now()) : null;
  }

  private seats(): number {
    return Number(this.meta("seats") ?? "1") || 1;
  }

  /** Send to the host. False if there's no open socket or sending failed. */
  private send(ws: WebSocket | undefined, msg: unknown): boolean {
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.warn("send to host failed", err);
      return false;
    }
  }

  private wake(jobId: string) {
    const set = this.waiters.get(jobId);
    if (!set) return;
    this.waiters.delete(jobId);
    for (const resolve of set) resolve();
  }

  private allSessionIds(): string[] {
    return this.sql.exec<{ id: string }>(`SELECT id FROM sessions`).toArray().map((r) => r.id);
  }

  /** Tell the host app who is connected right now (one query, whatever the number of seats). */
  private announce() {
    const sessions = this.sql
      .exec<{ id: string; name: string; created_at: number; busy: number }>(
        `SELECT s.id, s.name, s.created_at,
                EXISTS (SELECT 1 FROM jobs j WHERE j.session_id = s.id AND j.status = 'running') AS busy
         FROM sessions s ORDER BY s.created_at`,
      )
      .toArray()
      .map((s) => ({ id: s.id, name: s.name, since: s.created_at, busy: s.busy === 1 }));
    this.send(this.hostSocket(), { type: "sessions", sessions });
  }

  private async session(token: string): Promise<SessionRow | null> {
    if (!this.registered) return null;
    const rows = this.sql.exec<SessionRow>(`SELECT * FROM sessions WHERE token_hash = ?`, await sha256(token)).toArray();
    if (!rows.length) return null;
    const s = rows[0];
    const now = Date.now();
    if (now - s.last_seen > SESSION_IDLE_MS) {
      this.endSessions([s.id], "Your session timed out.");
      return null;
    }
    if (now - s.last_seen > LAST_SEEN_RESOLUTION_MS) this.sql.exec(`UPDATE sessions SET last_seen = ? WHERE id = ?`, now, s.id);
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

  private failJob(jobId: string, error: string) {
    this.sql.exec(`UPDATE jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'running'`, error, Date.now(), jobId);
    this.wake(jobId);
  }

  private async ensureAlarm(at = Date.now() + SWEEP_MS) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private getJobRow(jobId: string): JobRow | null {
    const rows = this.sql.exec<JobRow>(`SELECT * FROM jobs WHERE id = ?`, jobId).toArray();
    return rows.length ? rows[0] : null;
  }

  private recentFailures(ip: string, now: number): number {
    return this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM failed_logins WHERE ip = ? AND at > ?`, ip, now - FAILED_LOGIN_WINDOW_MS)
      .one().n;
  }

  // ----- RPC -----

  /** Claim this ID for a new host. False if it is taken. */
  async init(secret: string): Promise<boolean> {
    if (this.registered) return false;
    this.migrate();
    this.registered = true;
    this.setMeta("secret_hash", await sha256(secret));
    this.setMeta("last_connected", String(Date.now()));
    await this.ensureAlarm(Date.now() + STALE_HOST_MS);
    return true;
  }

  async openSession(password: string, name: string, ip: string): Promise<Result<unknown>> {
    const wrong = fail(401, "wrong_password", "Wrong ID or password.");
    if (!this.registered) return wrong;
    const now = Date.now();
    if (this.recentFailures(ip, now) >= MAX_FAILED_LOGINS) {
      return fail(429, "rate_limited", "Too many wrong passwords. Wait a minute and try again.");
    }
    const stored = this.meta("password_hash");
    if (!stored || !password || !(await verifyPassword(password, stored))) {
      this.sql.exec(`INSERT INTO failed_logins (ip, at) VALUES (?, ?)`, ip, now);
      await this.ensureAlarm();
      return wrong;
    }
    // Connected, and this connection has sent its password ("config"): only then is it sharing.
    if (!this.hostSocket() || !this.meta("password_hash_ready")) return fail(503, "not_sharing", "That host isn't sharing right now.");
    this.sweep();
    const used = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`).one().n;
    if (used >= this.seats()) {
      return fail(409, "seats_full", `All ${this.seats()} seats are taken. Try again when someone leaves.`);
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
    if (!s) return fail(401, "session_ended", "Your session has ended.");
    return ok({ online: !!this.hostSocket(), host_name: this.meta("name") ?? "", paused: this.paused() });
  }

  async ask(token: string, prompt: unknown, history: unknown, context?: unknown): Promise<Result<unknown>> {
    const s = await this.session(token);
    if (!s) return fail(401, "session_ended", "Your session has ended.");
    const ws = this.hostSocket();
    if (!ws) return fail(503, "not_sharing", "The host stopped sharing.");
    if (this.paused()) return fail(503, "paused", "The host paused sharing for now. Try again a little later.");
    if (typeof prompt !== "string" || !prompt.trim()) return fail(400, "bad_request", "Write a prompt first.");
    if (utf8Bytes(prompt) > MAX_PROMPT_BYTES) return fail(413, "too_large", "That prompt is too long.");

    const turns: Turn[] = [];
    if (history != null) {
      if (!Array.isArray(history) || history.length > MAX_HISTORY_TURNS) {
        return fail(413, "too_large", "This chat is too long. Start a new one.");
      }
      let bytes = 0;
      for (const item of history as unknown[]) {
        const t = item as { role?: unknown; content?: unknown } | null;
        if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string") {
          return fail(400, "bad_request", "Each earlier message needs a role and content.");
        }
        bytes += utf8Bytes(t.content);
        turns.push({ role: t.role, content: t.content });
      }
      if (bytes > MAX_HISTORY_BYTES) return fail(413, "too_large", "This chat is too long. Start a new one.");
    }
    if (context != null && (typeof context !== "string" || utf8Bytes(context) > MAX_CONTEXT_BYTES)) {
      return fail(413, "too_large", "Your memory is too long to send. Remove some facts.");
    }
    const ctxText = typeof context === "string" && context.trim() ? context : null;
    // One prompt at a time per person, so seats cap how many run at once.
    const running = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE session_id = ? AND status = 'running'`, s.id).one().n;
    if (running > 0) return fail(409, "busy", "Wait for the current answer first.");

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
    // `session_id` is unused by current hosts, but v0.1.0 hosts reject a job without it.
    if (!this.send(ws, { type: "job", job_id: job.id, session_id: s.id, name: s.name, prompt, history: turns, context: ctxText })) {
      this.failJob(job.id, "The prompt couldn't be delivered to the host.");
      return fail(503, "not_sharing", "The prompt couldn't be delivered to the host. Try again.");
    }
    this.announce();
    await this.ensureAlarm();
    return ok({ job_id: job.id, status: job.status, text: null, error: null });
  }

  async getJob(token: string, jobId: string, waitMs: number): Promise<Result<unknown>> {
    const s = await this.session(token);
    if (!s) return fail(401, "session_ended", "Your session has ended.");
    let job = this.getJobRow(jobId);
    if (!job || job.session_id !== s.id) return fail(404, "not_found", "That prompt wasn't found.");
    if (job.status === "running" && waitMs > 0) {
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
      if (!job) return fail(404, "not_found", "That prompt wasn't found.");
    }
    return ok({ job_id: job.id, status: job.status, text: job.result, error: job.error });
  }

  // ----- the host app's WebSocket -----

  async fetch(request: Request): Promise<Response> {
    const token = bearer(request);
    const stored = this.registered ? this.meta("secret_hash") : null;
    if (!token || !stored || !equalSecret(stored, await sha256(token))) {
      return errorResponse(401, "session_ended", "invalid host secret");
    }

    for (const old of this.ctx.getWebSockets("host")) {
      try {
        old.close(4000, "replaced by a newer connection");
      } catch {}
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["host"]);
    // Nobody can connect until this connection sends its password and seats ("config"), and it
    // starts unpaused; the host re-sends its pause state right after "config".
    this.deleteMeta("password_hash_ready");
    this.deleteMeta("paused");
    this.setMeta("last_connected", String(Date.now()));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Record<string, unknown>;
    try {
      await this.handleHostMessage(msg);
    } catch (err) {
      console.error("host message failed", err);
      // An answer that couldn't be stored mustn't leave its asker waiting an hour.
      if (msg.type === "result" && typeof msg.job_id === "string") {
        this.failJob(msg.job_id, "The answer couldn't be delivered (it may be too large).");
      }
    }
  }

  private async handleHostMessage(msg: Record<string, unknown>) {
    const now = Date.now();

    if (msg.type === "config") {
      if (typeof msg.password === "string" && msg.password.length >= MIN_PASSWORD_CHARS) {
        const stored = this.meta("password_hash");
        const same = stored !== null && (await verifyPassword(msg.password, stored));
        if (!same || isLegacyHash(stored)) this.setMeta("password_hash", await hashPassword(msg.password));
        this.setMeta("password_hash_ready", "1");
        // A new password ends everyone's session: the old one may have reached people it shouldn't.
        if (!same) this.endSessions(this.allSessionIds(), "The host changed the password.");
      }
      if (typeof msg.seats === "number") this.setMeta("seats", String(Math.min(Math.max(Math.floor(msg.seats), 1), MAX_SEATS)));
      if (typeof msg.name === "string") this.setMeta("name", cleanName(msg.name, "", MAX_NAME_CHARS));
      this.announce();
      await this.ensureAlarm();
      return;
    }

    if (msg.type === "pause") {
      const p = msg.paused as { kind?: unknown; until?: unknown } | null;
      if (p && typeof p === "object" && (p.kind === "limit" || p.kind === "busy")) {
        this.setMeta("paused", JSON.stringify({ kind: p.kind, until: typeof p.until === "number" ? p.until : null }));
      } else {
        this.deleteMeta("paused");
      }
      return;
    }

    if (msg.type === "kick" && typeof msg.session_id === "string") {
      this.endSessions([msg.session_id], "The host disconnected you.");
      return;
    }

    if (msg.type === "result" && typeof msg.job_id === "string") {
      const status = msg.status === "done" ? "done" : "error";
      const text = typeof msg.text === "string" ? truncateBytes(msg.text, MAX_RESULT_BYTES) : null;
      const error = typeof msg.error === "string" ? truncateBytes(msg.error, MAX_ERROR_BYTES) : null;
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
    // The host stopped sharing: everyone is disconnected, and any pause ends with it.
    if (!this.ctx.getWebSockets("host").some((w) => w !== ws && w.readyState === WebSocket.OPEN)) {
      this.endSessions(this.allSessionIds(), "The host stopped sharing.");
      this.deleteMeta("paused");
      this.setMeta("last_connected", String(Date.now()));
      await this.ensureAlarm();
    }
  }

  async webSocketError(_ws: WebSocket, error: unknown) {
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
    this.sql.exec(`DELETE FROM failed_logins WHERE at < ?`, now - FAILED_LOGIN_WINDOW_MS);
  }

  async alarm() {
    if (!this.registered) return;
    this.sweep();
    const now = Date.now();
    const pending =
      this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`).one().n +
      this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs`).one().n +
      this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM failed_logins`).one().n;
    if (pending > 0) return this.ctx.storage.setAlarm(now + SWEEP_MS);
    if (this.hostSocket()) return; // connected hosts aren't stale; disconnecting schedules the next check
    // A host that hasn't connected in a long time, with nothing pending, is deleted for good.
    const lastConnected = Number(this.meta("last_connected") ?? "0");
    if (now - lastConnected >= STALE_HOST_MS) {
      await this.ctx.storage.deleteAll();
      this.registered = false;
      return;
    }
    await this.ctx.storage.setAlarm(lastConnected + STALE_HOST_MS);
  }
}
