import { useState } from "react";

import { ChatPane } from "./ChatPane";
import { ConnectScreen } from "./ConnectScreen";
import { MemoryDialog } from "./MemoryDialog";
import { Sidebar } from "./Sidebar";
import { useBackend } from "./backend";

/** `brand` shows the logo in the sidebar; the desktop app has it in its top bar instead. */
export function ClientApp({ brand = true }: { brand?: boolean }) {
  const backend = useBackend();
  const state = backend.useState();
  // The open chat; null is a new one that starts when you send.
  const [chatId, setChatId] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);

  if (!state) return null;
  if (!state.connection) return <ConnectScreen lastId={state.last_id} notice={state.notice} themeToggle={brand} />;

  const conn = state.connection;
  const chat = state.chats.find((c) => c.id === chatId) ?? null;

  return (
    <div className="flex h-full">
      <Sidebar
        brand={brand}
        chats={state.chats}
        chatId={chatId}
        onChat={setChatId}
        connection={conn}
        memory={state.memory}
        onMemory={() => setMemoryOpen(true)}
      />
      <ChatPane
        key={chat?.id ?? "new"}
        chat={chat}
        hostName={conn.host_name || "the host"}
        memory={state.memory}
        paused={conn.paused ?? null}
        onStarted={setChatId}
      />
      <MemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} memory={state.memory} />
    </div>
  );
}
