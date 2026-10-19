// The relay's HTTP API, as the web client uses it. Decisions (end the session? retry?) are made
// on the relay's `code`, never on message text; mirrors RelayError in crates/tokenbud-core.

export type RelayCode =
  | "wrong_password"
  | "rate_limited"
  | "seats_full"
  | "busy"
  | "not_sharing"
  | "paused"
  | "session_ended"
  | "too_large"
  | "bad_request"
  | "not_found";

export class RelayError extends Error {
  /** HTTP status, or 0 when the relay couldn't be reached at all. */
  readonly status: number;
  readonly code: RelayCode | null;

  constructor(status: number, code: RelayCode | null, message: string) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
  }

  static unreachable() {
    return new RelayError(0, null, "Could not reach the relay. Check your internet connection.");
  }

  /** The seat is gone (kicked, timed out, host stopped): stop using it. */
  get sessionEnded(): boolean {
    return this.code === "session_ended" || this.code === "not_sharing" || (this.code === null && this.status === 401);
  }

  /** Worth retrying: the network or the relay hiccuped (5xx without a reason we understand). */
  get transient(): boolean {
    return this.status === 0 || (this.status >= 500 && this.code === null);
  }
}

export const isRelayError = (e: unknown): e is RelayError => e instanceof RelayError;

export interface ApiOptions {
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
  keepalive?: boolean;
}

export async function api<T>(method: string, path: string, { token, body, signal, keepalive }: ApiOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      keepalive,
      signal,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw RelayError.unreachable();
  }
  const data: unknown = await res.json().catch(() => null);
  const field = (name: string) => (data && typeof data === "object" ? (data as Record<string, unknown>)[name] : undefined);
  if (!res.ok) {
    const code = typeof field("code") === "string" ? (field("code") as RelayCode) : null;
    const message = typeof field("error") === "string" ? (field("error") as string) : `relay error ${res.status}`;
    throw new RelayError(res.status, code, message);
  }
  return data as T;
}
