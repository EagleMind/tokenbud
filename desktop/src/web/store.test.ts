import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetForTests, snapshot, web } from "./store";

// IndexedDB isn't there in Node; the store only needs somewhere to write.
vi.mock("./idb", () => ({ get: async () => undefined, set: async () => {} }));

type Reply = { status?: number; body: unknown };
type Route = (method: string, path: string, body: unknown) => Reply | undefined;

/** Answers fetch calls from a list of routes, and keeps what was asked. */
function relay(route: Route) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: String(init.method), path, body });
      const r = route(String(init.method), path, body);
      if (!r) throw new Error(`unexpected ${init.method} ${path}`);
      return Response.json(r.body, { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const HOST = "418203977";
const joined: Route = (method, path) =>
  method === "POST" && path === `/v1/hosts/${HOST}/sessions` ? { body: { session_token: "tok", host_name: "Maya" } } : undefined;

/** Lets pending promises and the given time run. */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  resetForTests();
});

afterEach(() => {
  resetForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connect", () => {
  it("takes a seat and never stores the password", async () => {
    const calls = relay(joined);
    await web.connect("418 203 977", " pw ", "Sam");
    expect(calls[0].body).toEqual({ password: "pw", name: "Sam" });
    expect(snapshot().connection).toEqual({ host_id: HOST, host_name: "Maya", online: true });
  });

  it("rejects an ID that isn't 9 digits without asking the relay", async () => {
    const calls = relay(() => undefined);
    await expect(web.connect("123", "pw")).rejects.toThrow("9 digits");
    expect(calls).toHaveLength(0);
  });

  it("passes on the relay's reason", async () => {
    relay(() => ({ status: 401, body: { error: "Wrong ID or password.", code: "wrong_password" } }));
    await expect(web.connect(HOST, "nope")).rejects.toThrow("Wrong ID or password.");
    expect(snapshot().connection).toBeNull();
  });
});

describe("send", () => {
  it("asks, waits for the answer, and sends the chat so far next time", async () => {
    let polls = 0;
    const calls = relay((method, path, body) => {
      if (joined(method, path, body)) return joined(method, path, body);
      if (path.endsWith("/ask")) return { status: 202, body: { job_id: "j1", status: "running", text: null, error: null } };
      if (path.includes("/jobs/j1")) return { body: { job_id: "j1", status: ++polls < 2 ? "running" : "done", text: "Hello! <remember>Writes Go</remember>", error: null } };
    });
    await web.connect(HOST, "pw");
    const chatId = await web.send(null, "  Hi there  ");
    await tick();

    const chat = snapshot().chats.find((c) => c.id === chatId)!;
    expect(chat.title).toBe("Hi there");
    expect(chat.messages[0]).toMatchObject({ prompt: "Hi there", state: "done", answer: "Hello! <remember>Writes Go</remember>" });
    expect(polls).toBe(2);

    await web.send(chatId, "Again");
    const ask = calls.filter((c) => c.path.endsWith("/ask"))[1];
    expect(ask.body).toMatchObject({
      prompt: "Again",
      history: [
        { role: "user", content: "Hi there" },
        { role: "assistant", content: "Hello!" },
      ],
    });
  });

  it("keeps waiting through a relay hiccup", async () => {
    let polls = 0;
    relay((method, path, body) => {
      if (joined(method, path, body)) return joined(method, path, body);
      if (path.endsWith("/ask")) return { body: { job_id: "j1", status: "running", text: null, error: null } };
      if (path.includes("/jobs/j1")) return ++polls === 1 ? { status: 502, body: null } : { body: { job_id: "j1", status: "done", text: "ok", error: null } };
    });
    await web.connect(HOST, "pw");
    const chatId = await web.send(null, "Hi");
    await tick(2_000);
    expect(snapshot().chats.find((c) => c.id === chatId)!.messages[0]).toMatchObject({ state: "done", answer: "ok" });
    expect(snapshot().connection).not.toBeNull();
  });

  it("ends the session when the relay says it's over", async () => {
    relay((method, path, body) => {
      if (joined(method, path, body)) return joined(method, path, body);
      if (path.endsWith("/ask")) return { status: 401, body: { error: "Your session ended.", code: "session_ended" } };
    });
    await web.connect(HOST, "pw");
    const chatId = await web.send(null, "Hi");
    await tick();
    expect(snapshot().connection).toBeNull();
    expect(snapshot().chats.find((c) => c.id === chatId)!.messages[0]).toMatchObject({ state: "error", error: "Your session ended." });
  });

  it("won't send while an answer is coming", async () => {
    relay((method, path, body) => joined(method, path, body) ?? { body: { job_id: "j1", status: "running", text: null, error: null } });
    await web.connect(HOST, "pw");
    const chatId = await web.send(null, "Hi");
    await expect(web.send(chatId, "Hello?")).rejects.toThrow("Wait for the answer");
  });
});

describe("ping", () => {
  it("marks the host offline on a server error but keeps the seat", async () => {
    relay((method, path, body) => joined(method, path, body) ?? (path.endsWith("/ping") ? { status: 502, body: null } : undefined));
    await web.connect(HOST, "pw");
    await tick(15_000);
    expect(snapshot().connection).toMatchObject({ host_id: HOST, online: false });
  });

  it("shows a pause", async () => {
    const paused = { kind: "limit", until: 123 };
    relay((method, path, body) => joined(method, path, body) ?? (path.endsWith("/ping") ? { body: { online: true, paused } } : undefined));
    await web.connect(HOST, "pw");
    await tick(15_000);
    expect(snapshot().connection).toMatchObject({ online: true, paused });
  });

  it("ends the session when the host kicks you", async () => {
    relay(
      (method, path, body) =>
        joined(method, path, body) ?? (path.endsWith("/ping") ? { status: 401, body: { error: "The host ended your session.", code: "session_ended" } } : undefined),
    );
    await web.connect(HOST, "pw");
    await tick(15_000);
    expect(snapshot().connection).toBeNull();
    expect(snapshot().notice).toBe("The host ended your session.");
  });
});

describe("memory", () => {
  it("ignores a fact it already has, whatever the case", async () => {
    await web.addMemory("Writes Go");
    await web.addMemory("  writes   go ");
    expect(snapshot().memory.facts.map((f) => f.text)).toEqual(["Writes Go"]);
  });

  it("refuses an empty fact", async () => {
    await expect(web.addMemory("   ")).rejects.toThrow();
  });

  it("remembers a dismissed suggestion once", async () => {
    await web.dismissSuggestion("Uses Vim");
    await web.dismissSuggestion("Uses Vim");
    expect(snapshot().memory.dismissed).toEqual(["Uses Vim"]);
  });
});
