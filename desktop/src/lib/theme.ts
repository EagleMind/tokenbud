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

/** The chosen theme, and what it resolves to right now. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current);
  const resolved: "light" | "dark" = theme === "dark" || (theme === "system" && media.matches) ? "dark" : "light";
  return { theme, resolved, setTheme };
}
