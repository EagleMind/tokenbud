// Runs the real Worker and Durable Object locally (Miniflare) and talks to them over HTTP and a
// WebSocket, like the host app and the clients do.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { activePause, cleanName, hashPassword, sha256, truncateBytes, verifyPassword } from "../src/util";

const BASE = "https://relay.test";
const PASSWORD = "k7m2pqxa";

async function call(path: string, init: RequestInit & { ip?: string; token?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.ip ?? "203.0.113.1");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await SELF.fetch(BASE + path, { ...init, headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A registered host with its WebSocket open and its password sent. */
async function startHost(password = PASSWORD) {
  const reg = await call("/v1/hosts", { method: "POST" });
  const { host_id, host_secret } = reg.body as { host_id: string; host_secret: string };
  const res = await SELF.fetch(`${BASE}/v1/hosts/${host_id}/connect`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${host_secret}` },
  });
  const ws = res.webSocket!;
  ws.accept();
  const messages: Record<string, unknown>[] = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string" && e.data !== "pong") messages.push(JSON.parse(e.data));
  });
  ws.send(JSON.stringify({ type: "config", password, seats: 2, name: "Maya" }));
  await settle();
  return { hostId: host_id, ws, messages };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

const openSession = (hostId: string, password: string, ip?: string) =>
  call(`/v1/hosts/${hostId}/sessions`, { method: "POST", body: JSON.stringify({ password, name: "Sam" }), ip });

describe("sessions", () => {
  it("lets the right password in and says who the host is", async () => {
    const { hostId } = await startHost();
    const r = await openSession(hostId, PASSWORD);
    expect(r.status).toBe(201);
    expect(r.body.host_name).toBe("Maya");
  });

  it("limits wrong passwords per caller, never locking out others", async () => {
    const { hostId } = await startHost();
    for (let i = 0; i < 10; i++) expect((await openSession(hostId, "wrongpass", "198.51.100.7")).status).toBe(401);
    const blocked = await openSession(hostId, "wrongpass", "198.51.100.7");
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("rate_limited");
    // Someone else, with the right password, still gets in.
    expect((await openSession(hostId, PASSWORD, "198.51.100.8")).status).toBe(201);
  });

  it("answers an unknown ID exactly like a wrong password", async () => {
    const unknown = await openSession("123456789", PASSWORD);
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe("wrong_password");
    const malformed = await openSession("12", PASSWORD);
    expect(malformed.body).toEqual(unknown.body);
  });

  it("ends sessions with a code clients can act on", async () => {
    const { hostId } = await startHost();
    const r = await call(`/v1/hosts/${hostId}/ping`, { token: "tbs_nope" });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("session_ended");
  });

  it("disconnects everyone when the password changes", async () => {
    const { hostId, ws } = await startHost();
    const token = (await openSession(hostId, PASSWORD)).body.session_token as string;
    ws.send(JSON.stringify({ type: "config", password: "a-new-password", seats: 2, name: "Maya" }));
    await settle();
    expect((await call(`/v1/hosts/${hostId}/ping`, { token })).body.code).toBe("session_ended");
    expect((await openSession(hostId, PASSWORD)).status).toBe(401);
    expect((await openSession(hostId, "a-new-password")).status).toBe(201);
  });

  it("ends a session right away when the host disconnects that person", async () => {
    const { hostId, ws, messages } = await startHost();
    const token = (await openSession(hostId, PASSWORD)).body.session_token as string;
    await settle();
    const list = messages.filter((m) => m.type === "sessions").at(-1) as { sessions: { id: string }[] };
    ws.send(JSON.stringify({ type: "kick", session_id: list.sessions[0].id }));
    await settle();
    expect((await call(`/v1/hosts/${hostId}/ping`, { token })).body.code).toBe("session_ended");
  });

  it("keeps to the host's number of seats", async () => {
    const { hostId } = await startHost();
    expect((await openSession(hostId, PASSWORD)).status).toBe(201);
    expect((await openSession(hostId, PASSWORD)).status).toBe(201);
    const full = await openSession(hostId, PASSWORD);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("seats_full");
  });
});

describe("prompts", () => {
  it("refuses bodies over the size limit before parsing them", async () => {
    const { hostId } = await startHost();
    const token = (await openSession(hostId, PASSWORD)).body.session_token as string;
    const r = await call(`/v1/hosts/${hostId}/ask`, { method: "POST", token, body: JSON.stringify({ prompt: "x".repeat(1_600_000) }) });
    expect(r.status).toBe(413);
    expect(r.body.code).toBe("too_large");
  });

  it("delivers prompts with memory, and returns the host's answer", async () => {
    const { hostId, ws, messages } = await startHost();
    const token = (await openSession(hostId, PASSWORD)).body.session_token as string;
    const asked = await call(`/v1/hosts/${hostId}/ask`, {
      method: "POST",
      token,
      body: JSON.stringify({ prompt: "hi", history: [], context: "Writes Go" }),
    });
    expect(asked.status).toBe(202);
    await settle();
    const job = messages.find((m) => m.type === "job")!;
    expect(job.context).toBe("Writes Go");
    // v0.1.0 hosts can't read a job without it.
    expect(job.session_id).toEqual(expect.any(String));
    ws.send(JSON.stringify({ type: "result", job_id: job.job_id, status: "done", text: "hello" }));
    await settle();
    const done = await call(`/v1/hosts/${hostId}/jobs/${job.job_id}?wait=1`, { token });
    expect(done.body).toMatchObject({ status: "done", text: "hello" });
  });

  it("takes one prompt at a time per person", async () => {
    const { hostId } = await startHost();
    const token = (await openSession(hostId, PASSWORD)).body.session_token as string;
    const ask = () => call(`/v1/hosts/${hostId}/ask`, { method: "POST", token, body: JSON.stringify({ prompt: "hi", history: [] }) });
    expect((await ask()).status).toBe(202);
    const second = await ask();
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("busy");
  });

  it("holds prompts while paused, but not after the pause has expired", async () => {
    const { hostId, ws } = await startHost();
    const token = (await openSession(hostId, PASSWORD)).body.session_token as string;
    const ask = () => call(`/v1/hosts/${hostId}/ask`, { method: "POST", token, body: JSON.stringify({ prompt: "hi", history: [] }) });

    ws.send(JSON.stringify({ type: "pause", paused: { kind: "limit", until: Date.now() + 60_000 } }));
    await settle();
    const held = await ask();
    expect(held.status).toBe(503);
    expect(held.body.code).toBe("paused");

    ws.send(JSON.stringify({ type: "pause", paused: { kind: "limit", until: Date.now() - 1 } }));
    await settle();
    expect((await ask()).status).toBe(202);
  });

  it("ignores messages that aren't objects", async () => {
    const { hostId, ws } = await startHost();
    ws.send("null");
    ws.send("[1,2]");
    await settle();
    expect((await openSession(hostId, PASSWORD)).status).toBe(201);
  });
});

describe("helpers", () => {
  it("hashes passwords with a salt and still accepts older plain hashes", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword("nope-nope", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, await sha256(PASSWORD))).toBe(true);
  });

  it("cuts by bytes without breaking characters", () => {
    expect(truncateBytes("héllo", 2)).toBe("h");
    expect(truncateBytes("😀😀", 5)).toBe("😀");
    expect(truncateBytes("short", 100)).toBe("short");
  });

  it("cleans names of control and direction characters", () => {
    expect(cleanName("Sam‮ nimdA", "x", 64)).toBe("Sam nimdA");
    expect(cleanName("\u0000\u0007", "Someone", 64)).toBe("Someone");
  });

  it("treats a pause past its end as over", () => {
    expect(activePause({ kind: "limit", until: 10 }, 20)).toBeNull();
    expect(activePause({ kind: "limit", until: 30 }, 20)).not.toBeNull();
    expect(activePause({ kind: "busy", until: null }, 20)).not.toBeNull();
  });
});
