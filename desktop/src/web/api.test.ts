import { afterEach, describe, expect, it, vi } from "vitest";

import { api, RelayError } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("RelayError", () => {
  it("ends the session only when the relay says so", () => {
    expect(new RelayError(401, "session_ended", "").sessionEnded).toBe(true);
    expect(new RelayError(503, "not_sharing", "").sessionEnded).toBe(true);
    expect(new RelayError(401, null, "").sessionEnded).toBe(true);
    expect(new RelayError(401, "wrong_password", "").sessionEnded).toBe(false);
    expect(new RelayError(502, null, "").sessionEnded).toBe(false);
    expect(RelayError.unreachable().sessionEnded).toBe(false);
  });

  it("retries network and unexplained server errors only", () => {
    expect(RelayError.unreachable().transient).toBe(true);
    expect(new RelayError(502, null, "").transient).toBe(true);
    expect(new RelayError(503, "paused", "").transient).toBe(false);
    expect(new RelayError(409, "busy", "").transient).toBe(false);
  });
});

describe("api", () => {
  it("sends the token and body, and returns the JSON", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: 1 }));
    vi.stubGlobal("fetch", fetch);
    await expect(api("POST", "/v1/x", { token: "t", body: { a: 1 } })).resolves.toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledWith(
      "/v1/x",
      expect.objectContaining({
        method: "POST",
        body: '{"a":1}',
        headers: { authorization: "Bearer t", "content-type": "application/json" },
      }),
    );
  });

  it("turns an error answer into a RelayError with its code", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "Wrong ID or password.", code: "wrong_password" }, { status: 401 }));
    await expect(api("GET", "/v1/x")).rejects.toMatchObject({ status: 401, code: "wrong_password", message: "Wrong ID or password." });
  });

  it("copes with an error that isn't JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("Bad gateway", { status: 502 }));
    await expect(api("GET", "/v1/x")).rejects.toMatchObject({ status: 502, code: null, transient: true });
  });

  it("reports an unreachable relay", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api("GET", "/v1/x")).rejects.toMatchObject({ status: 0, transient: true });
  });
});
