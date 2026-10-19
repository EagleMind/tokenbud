import { useSyncExternalStore } from "react";

// Light, dark, or whatever the system uses (the default). Remembered per device.

export type Theme = "light" | "dark" | "system";

const KEY = "tokenbud-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): Theme {
  const forced = new URLSearchParams(location.search).get("theme");
  if (forced === "light" || forced === "dark") return forced;
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable: follow the system */
  }
  return "system";
}

let current: Theme = read();

function apply() {
  const dark = current === "dark" || (current === "system" && media.matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

apply();
media.addEventListener("change", () => {
  if (current === "system") {
    apply();
    listeners.forEach((l) => l());
  }
});

export function setTheme(t: Theme) {
  current = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* applies for now, just isn't remembered */
  }
  apply();
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const resolve = (t: Theme): "light" | "dark" => (t === "dark" || (t === "system" && media.matches) ? "dark" : "light");

/** The chosen theme, and what it resolves to right now (which follows the system for "system"). */
export function useTheme() {
  // The snapshot includes the resolved theme, so a system dark-mode switch re-renders too.
  const snapshot = useSyncExternalStore(subscribe, () => `${current}:${resolve(current)}`);
  const [theme, resolved] = snapshot.split(":") as [Theme, "light" | "dark"];
  return { theme, resolved, setTheme };
}
