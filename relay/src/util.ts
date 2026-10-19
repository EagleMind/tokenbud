// Pure helpers for the relay: hashing, size limits, names and the error contract.
// Kept free of Durable Object state so they can be tested on their own.

/** Machine-readable reasons, next to the sentence for people. The Rust and web clients decide on these. */
export type ErrorCode =
  | "wrong_password" // 401: unknown ID or wrong password (deliberately the same answer)
  | "rate_limited" // 429
  | "seats_full" // 409
  | "busy" // 409: a prompt is already running for this person
  | "not_sharing" // 503: host offline, stopped, or the prompt couldn't be delivered
  | "paused" // 503: the host's reserve paused sharing
  | "session_ended" // 401: unknown, expired or kicked session
  | "too_large" // 413
  | "bad_request" // 400
  | "not_found"; // 404

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; code: ErrorCode; error: string };
export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = (status: number, code: ErrorCode, error: string): Result<never> => ({ ok: false, status, code, error });

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function errorResponse(status: number, code: ErrorCode, error: string): Response {
  return json({ error, code }, status);
}

export const fromResult = <T>(r: Result<T>, okStatus = 200) => (r.ok ? json(r.data, okStatus) : errorResponse(r.status, r.code, r.error));

// ----- randomness and hashing -----

const encoder = new TextEncoder();

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 9 digits, never starting with 0, like "418 203 977". */
export function randomHostId(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900_000_000;
  return String(100_000_000 + n);
}

const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

/** For high-entropy secrets (host secrets, session tokens): fast, and still unguessable. */
export async function sha256(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

/** Compare without leaking how much matched through timing. */
export function equalSecret(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// Passwords are short and human-made, so they get a slow, salted hash. 100,000 is the most
// PBKDF2 iterations Workers allow.
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;

async function pbkdf2(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return hex(bits);
}

/** "pbkdf2$<salt hex>$<hash hex>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `pbkdf2$${hex(salt)}$${await pbkdf2(password, salt)}`;
}

/** Checks a password against a stored hash. Plain SHA-256 hashes from older relays still verify. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme === "pbkdf2" && salt && hash) return equalSecret(await pbkdf2(password, unhex(salt)), hash);
  return equalSecret(await sha256(password), stored);
}

export const isLegacyHash = (stored: string) => !stored.startsWith("pbkdf2$");

// ----- sizes -----

/** Size in UTF-8 bytes: what storage and WebSocket limits count, unlike `string.length`. */
export const utf8Bytes = (s: string) => encoder.encode(s).byteLength;

/** At most `max` UTF-8 bytes of `s`, never ending in a broken character. */
export function truncateBytes(s: string, max: number): string {
  const bytes = encoder.encode(s);
  if (bytes.byteLength <= max) return s;
  return new TextDecoder().decode(bytes.subarray(0, max)).replace(/�+$/, "");
}

// ----- names -----

/** Names are shown to the other side: no control or direction-override characters (spoofing). */
export function cleanName(v: unknown, fallback: string, max: number): string {
  const s = typeof v === "string" ? v.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "").trim().slice(0, max).trim() : "";
  return s || fallback;
}

// ----- the host's pause -----

export type Paused = { kind: "limit" | "busy"; until: number | null };

/** A pause whose `until` has passed is over, whether or not the host said so yet. */
export function activePause(p: Paused | null, now: number): Paused | null {
  if (!p) return null;
  if (p.until !== null && p.until <= now) return null;
  return p;
}
