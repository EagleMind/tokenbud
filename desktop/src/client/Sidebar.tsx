import { useState } from "react";
import { Brain, LogOut, SquarePen, Trash2 } from "lucide-react";

import { FriendAvatar, Wordmark } from "@/components/brand";
import { ConfirmDialog } from "@/components/confirm";
import { ThemeToggle } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { run } from "@/lib/errors";
import { formatId } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type Chat, type ClientState, type Memory, useBackend } from "./backend";

export function Sidebar({
  brand,
  chats,
  chatId,
  onChat,
  connection: conn,
  memory,
  onMemory,
}: {
  brand: boolean;
  chats: Chat[];
  chatId: string | null;
  onChat: (id: string | null) => void;
  connection: NonNullable<ClientState["connection"]>;
  memory: Memory;
  onMemory: () => void;
}) {
  const backend = useBackend();
  const [deleting, setDeleting] = useState<Chat | null>(null);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar">
      {brand && (
        <div className="px-5 pt-6 pb-2">
          <Wordmark alive={conn.online} />
        </div>
      )}
      <div className="px-3 pt-4">
        <Button variant={chatId ? "ghost" : "secondary"} className="w-full justify-start gap-2.5" onClick={() => onChat(null)}>
          <SquarePen /> New chat
        </Button>
      </div>
      <nav className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Chats">
        {chats.map((c) => {
          const running = c.messages.some((m) => m.state === "running");
          return (
            <div
              key={c.id}
              className={cn(
                "group flex items-center rounded-lg border border-transparent transition-colors",
                c.id === chatId ? "border-border bg-card" : "hover:bg-card",
              )}
            >
              <button
                onClick={() => onChat(c.id)}
                aria-current={c.id === chatId ? "true" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  c.id === chatId ? "font-medium" : "text-muted-foreground group-hover:text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {running && (
                  <>
                    <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                    <span className="sr-only">(answer coming)</span>
                  </>
                )}
              </button>
              {/* Shown on hover, and on keyboard focus (opacity, not display, keeps it focusable). */}
              <button
                onClick={() => setDeleting(c)}
                className="mr-1 rounded-md p-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={`Delete chat: ${c.title}`}
                title="Delete chat"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          );
        })}
      </nav>
      <div className="px-3 pb-2">
        <Button variant="ghost" className="w-full justify-start gap-2.5 text-muted-foreground" onClick={onMemory}>
          <Brain /> Memory
          <span className="ml-auto text-xs tabular-nums">{memory.enabled ? memory.facts.length || "" : "Off"}</span>
        </Button>
      </div>
      <div className="border-t p-3">
        <div className="flex items-center gap-3 rounded-xl px-2 py-1.5">
          <FriendAvatar name={conn.host_name || "Host"} online={conn.online} className="size-8" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium">{conn.host_name || formatId(conn.host_id)}</div>
            <div className={cn("text-xs", conn.online && !conn.paused ? "text-live" : "text-wait-ink")} aria-live="polite">
              {!conn.online ? "Host unreachable" : conn.paused ? "Paused" : "Connected"}
            </div>
          </div>
          {brand && <ThemeToggle />}
          <Button variant="ghost" size="icon" className="size-8" onClick={() => run(backend.disconnect())} aria-label="Disconnect" title="Disconnect">
            <LogOut />
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this chat?"
        description={`“${deleting?.title ?? ""}” will be removed from this device. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (!deleting) return;
          if (deleting.id === chatId) onChat(null);
          run(backend.deleteChat(deleting.id));
        }}
      />
    </aside>
  );
}
