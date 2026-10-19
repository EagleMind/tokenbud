import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { Settings2 } from "lucide-react";

import "@/lib/theme";
import "@/index.css";
import { ClientApp } from "@/client/App";
import { BackendContext, type ClientBackend, type ClientState } from "@/client/backend";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HostApp } from "@/host/App";
import type { SettingsSection } from "@/host/types";
import { Settings } from "@/settings/Settings";
import { call, useBackendState } from "@/lib/backend";
import { cn } from "@/lib/utils";

// Client mode in the desktop app: the session and chats live in Rust (apps/desktop/src/client.rs).
const tauri: ClientBackend = {
  useState: () => useBackendState<ClientState>("client_state", "client-changed").state,
  connect: (id, password) => call("connect", { id, password }),
  disconnect: () => call("disconnect"),
  clearNotice: () => call("clear_notice"),
  send: (chatId, prompt) => call<string>("send", { chatId, prompt }),
  deleteChat: (chatId) => call("delete_chat", { chatId }),
  addMemory: (text) => call("add_memory", { text }),
  updateMemory: (id, text) => call("update_memory", { id, text }),
  deleteMemory: (id) => call("delete_memory", { id }),
  setMemoryEnabled: (enabled) => call("set_memory_enabled", { enabled }),
  dismissSuggestion: (text) => call("dismiss_suggestion", { text }),
  asksName: false,
};

type Mode = "host" | "client";
const MODE_KEY = "tokenbud-mode";

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "host" ? "host" : "client";
  } catch {
    return "client";
  }
}

function App() {
  const [mode, setMode] = useState<Mode>(readMode);
  // Settings opens over either mode, at a section; null = the mode itself.
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const sharing = useSharing();

  const choose = (m: Mode) => {
    setMode(m);
    setSettings(null);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* not remembered next time */
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between border-b bg-sidebar px-5">
        <Wordmark alive={sharing} />
        <div className="flex rounded-xl border bg-background p-1" role="tablist" aria-label="Mode">
          <ModeButton active={mode === "client"} onClick={() => choose("client")}>
            Connect to an agent
          </ModeButton>
          <ModeButton active={mode === "host"} onClick={() => choose("host")}>
            Share my agent
            {sharing && <span className="size-1.5 rounded-full bg-live" aria-label="sharing" />}
          </ModeButton>
        </div>
        {/* Same width as the logo, so the switch sits in the middle. */}
        <div className="flex w-[8.5rem] justify-end">
          <Button
            variant={settings ? "secondary" : "ghost"}
            size="icon"
            className="size-9"
            onClick={() => setSettings(settings ? null : "model")}
            aria-label="Settings"
            title="Settings"
          >
            <Settings2 />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {settings ? (
          <Settings section={settings} onSection={setSettings} onBack={() => setSettings(null)} />
        ) : mode === "host" ? (
          <HostApp onSettings={setSettings} />
        ) : (
          <ClientApp brand={false} />
        )}
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Whether host mode is sharing right now, without starting it. */
function useSharing() {
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    const check = () => call<boolean>("is_sharing").then(setSharing, () => {});
    check();
    const unlisten = listen("host-changed", check);
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  return sharing;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <BackendContext.Provider value={tauri}>
        <App />
      </BackendContext.Provider>
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  </StrictMode>,
);
