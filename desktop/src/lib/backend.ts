import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

/** Calls a Rust command; errors come back as plain strings. */
export async function call<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}

/** Fallback poll, in case an event is ever missed. */
const SAFETY_POLL_MS = 4000;

/**
 * Keeps a snapshot of backend state: fetches it once, then again whenever the backend
 * emits `event`, when the window regains focus, and every few seconds as a safety net.
 *
 * Bursts of events are coalesced with a short timer. (Not requestAnimationFrame: the
 * webview pauses animation frames while the window is hidden or covered, which would
 * freeze updates until you came back to the window.) A snapshot identical to the last one
 * doesn't re-render: chats can be long, and re-parsing every answer each poll is wasteful.
 */
export function useBackendState<T>(getCmd: string, event: string, args?: Record<string, unknown>) {
  const [state, setState] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const last = useRef("");
  // Arguments by value, so a new object with the same contents doesn't refetch.
  const argsKey = JSON.stringify(args ?? null);

  const fetchNow = useCallback(async () => {
    if (inFlight.current) {
      again.current = true; // something changed mid-fetch: fetch once more after
      return;
    }
    inFlight.current = true;
    try {
      const next = await call<T>(getCmd, JSON.parse(argsKey) ?? undefined);
      const json = JSON.stringify(next);
      if (json !== last.current) {
        last.current = json;
        setState(next);
      }
    } catch (e) {
      console.error(e);
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        fetchNow();
      }
    }
  }, [getCmd, argsKey]);

  const refresh = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      fetchNow();
    }, 30);
  }, [fetchNow]);

  useEffect(() => {
    fetchNow();
    const unlisten = listen(event, refresh);
    const poll = setInterval(refresh, SAFETY_POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unlisten.then((f) => f());
      clearInterval(poll);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [event, fetchNow, refresh]);

  return state;
}
