import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Brain, Check, Loader2, LogOut, Pencil, Plus, SquarePen, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { FriendAvatar, Mark, Wordmark } from "@/components/brand";
import { CopyButton, Markdown, ThemeToggle } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clockTime, formatId } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type Chat, type Memory, type Message, MAX_FACT_CHARS, type Paused, splitSuggestions, useBackend } from "./backend";

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
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar">
        {brand && (
          <div className="px-5 pt-6 pb-2">
            <Wordmark alive={conn.online} />
          </div>
        )}
        <div className="px-3 pt-4">
          <Button
            variant={chat ? "ghost" : "secondary"}
            className="w-full justify-start gap-2.5"
            onClick={() => setChatId(null)}
          >
            <SquarePen /> New chat
          </Button>
        </div>
        <nav className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Chats">
          {state.chats.map((c) => {
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
                  onClick={() => setChatId(c.id)}
                  aria-current={c.id === chatId ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm",
                    c.id === chatId ? "font-medium" : "text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {running && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                </button>
                <button
                  onClick={() => {
                    if (c.id === chatId) setChatId(null);
                    backend.deleteChat(c.id);
                  }}
                  className="mr-1 hidden rounded-md p-1.5 text-muted-foreground group-hover:block hover:bg-muted hover:text-destructive focus-visible:block"
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
          <Button variant="ghost" className="w-full justify-start gap-2.5 text-muted-foreground" onClick={() => setMemoryOpen(true)}>
            <Brain /> Memory
            <span className="ml-auto text-xs tabular-nums">
              {state.memory.enabled ? state.memory.facts.length || "" : "Off"}
            </span>
          </Button>
        </div>
        <div className="border-t p-3">
          <div className="flex items-center gap-3 rounded-xl px-2 py-1.5">
            <FriendAvatar name={conn.host_name || "Host"} online={conn.online} className="size-8" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium">{conn.host_name || formatId(conn.host_id)}</div>
              <div className={cn("text-xs", conn.online && !conn.paused ? "text-live" : "text-wait-ink")}>
                {!conn.online ? "Host unreachable" : conn.paused ? "Paused" : "Connected"}
              </div>
            </div>
            {brand && <ThemeToggle />}
            <Button variant="ghost" size="icon" className="size-8" onClick={() => backend.disconnect()} aria-label="Disconnect" title="Disconnect">
              <LogOut />
            </Button>
          </div>
        </div>
      </aside>

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

/** Your local-first memory: facts that travel with each prompt, kept only on this device. */
function MemoryDialog({ open, onOpenChange, memory }: { open: boolean; onOpenChange: (o: boolean) => void; memory: Memory }) {
  const backend = useBackend();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const run = (p: Promise<void>) => p.catch((e) => toast.error((e as Error).message));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Memory</DialogTitle>
          <DialogDescription>
            Things the agent should know about you. Sent with each prompt to the agent you're connected to, and stored only
            on this device.
          </DialogDescription>
        </DialogHeader>

        <label className="flex items-center justify-between gap-4 rounded-xl bg-muted px-4 py-3 text-sm font-medium">
          Use memory
          <Switch checked={memory.enabled} onCheckedChange={(on) => run(backend.setMemoryEnabled(on))} />
        </label>

        <ul className={cn("space-y-1.5", !memory.enabled && "opacity-50")}>
          {memory.facts.length === 0 && (
            <li className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
              Nothing yet. Add something below, or accept a suggestion when the agent offers one.
            </li>
          )}
          {memory.facts.map((f) =>
            editing?.id === f.id ? (
              <li key={f.id}>
                <form
                  className="flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(backend.updateMemory(f.id, editing.text).then(() => setEditing(null)));
                  }}
                >
                  <Input
                    value={editing.text}
                    maxLength={MAX_FACT_CHARS}
                    onChange={(e) => setEditing({ id: f.id, text: e.target.value })}
                    autoFocus
                  />
                  <Button type="submit" size="icon" aria-label="Save">
                    <Check />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" onClick={() => setEditing(null)} aria-label="Cancel">
                    <X />
                  </Button>
                </form>
              </li>
            ) : (
              <li key={f.id} className="group flex items-center gap-2 rounded-xl border bg-background px-4 py-2 text-sm">
                <span className="selectable min-w-0 flex-1">{f.text}</span>
                <button
                  onClick={() => setEditing({ id: f.id, text: f.text })}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Edit: ${f.text}`}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  onClick={() => run(backend.deleteMemory(f.id))}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                  aria-label={`Forget: ${f.text}`}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ),
          )}
        </ul>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(backend.addMemory(draft).then(() => setDraft("")));
          }}
        >
          <Input
            value={draft}
            maxLength={MAX_FACT_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="For example: I write Rust, keep answers short"
          />
          <Button type="submit" disabled={!draft.trim()}>
            <Plus /> Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectScreen({ lastId, notice, themeToggle }: { lastId: string; notice: string | null; themeToggle: boolean }) {
  const backend = useBackend();
  const [id, setId] = useState(lastId ? formatId(lastId) : "");
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem("tokenbud-name") ?? "";
    } catch {
      return "";
    }
  });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = id.replace(/\D/g, "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (backend.asksName) {
        try {
          localStorage.setItem("tokenbud-name", name.trim());
        } catch {
          /* not remembered; still works */
        }
      }
      await backend.connect(digits, password, name.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative grid h-full place-items-center overflow-y-auto p-8">
      {themeToggle && <ThemeToggle className="absolute top-4 right-4" />}
      <form onSubmit={submit} className="w-full max-w-sm">
        <Mark together={false} className="h-14 w-20" />
        <h1 className="mt-5 text-[2rem] leading-tight font-semibold">Connect to an agent</h1>
        <p className="mt-2 text-[0.9375rem] text-muted-foreground">
          Enter the ID and password from the person sharing their agent with you.
        </p>

        {notice && (
          <p className="mt-6 rounded-xl bg-wait-soft px-4 py-3 text-sm text-wait-ink">
            {notice}
            <button type="button" className="ml-2 underline" onClick={() => backend.clearNotice()}>
              Dismiss
            </button>
          </p>
        )}

        <div className="mt-7 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="id">ID</Label>
            <Input
              id="id"
              value={id}
              onChange={(e) => setId(formatId(e.target.value.replace(/\D/g, "").slice(0, 9)))}
              placeholder="418 203 977"
              inputMode="numeric"
              autoFocus={!lastId}
              className="h-12 font-display text-xl tracking-wide tabular-nums"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus={!!lastId}
              autoComplete="off"
              spellCheck={false}
              className="h-12 font-mono text-lg tracking-wider"
            />
          </div>
          {backend.asksName && (
            <div className="space-y-2">
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="So the host knows who's connected"
                autoComplete="nickname"
                className="h-12"
              />
            </div>
          )}
          {error && <p className="rounded-xl bg-error-soft px-4 py-3 text-sm text-destructive">{error}</p>}
          <Button type="submit" size="lg" className="h-12 w-full text-base" disabled={busy || digits.length !== 9 || !password.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            Connect
          </Button>
        </div>
      </form>
    </div>
  );
}

function ChatPane({
  chat,
  hostName,
  memory,
  paused,
  onStarted,
}: {
  chat: Chat | null;
  hostName: string;
  memory: Memory;
  paused: Paused | null;
  onStarted: (id: string) => void;
}) {
  const backend = useBackend();
  const [prompt, setPrompt] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const messages = chat?.messages ?? [];
  const waiting = messages.some((m) => m.state === "running");

  const key = messages.map((m) => m.state).join(",");
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [key]);
  useEffect(() => input.current?.focus(), []);

  const send = async () => {
    const text = prompt.trim();
    if (!text || waiting || paused) return;
    try {
      const id = await backend.send(chat?.id ?? null, text);
      setPrompt("");
      if (!chat) onStarted(id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-8 py-10">
          {messages.length === 0 ? (
            <div className="py-16 text-center">
              <Mark className="mx-auto h-12 w-[4.25rem]" />
              <h2 className="mt-4 text-xl font-semibold">Ask {hostName}'s agent anything</h2>
              <p className="mx-auto mt-2 max-w-sm text-[0.9375rem] text-muted-foreground">
                It runs on their computer and only sees what you write here.
              </p>
            </div>
          ) : (
            messages.map((m, i) => <Exchange key={i} message={m} hostName={hostName} memory={memory} />)
          )}
        </div>
      </div>

      <div className="px-8 pb-6">
        {paused && (
          <p className="mx-auto mb-3 max-w-3xl rounded-xl bg-wait-soft px-4 py-2.5 text-sm text-wait-ink">
            {paused.kind === "limit"
              ? `${hostName} paused sharing to keep some for themselves. Back at ${paused.until ? clockTime(paused.until) : "a later time"}.`
              : `${hostName} paused sharing while they use Claude themselves. It resumes when they're done.`}
          </p>
        )}
        <div className="mx-auto max-w-3xl rounded-2xl border bg-card focus-within:border-primary">
          <Textarea
            ref={input}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={chat ? "Reply…" : `Message ${hostName}'s agent`}
            className="max-h-64 min-h-[3.5rem] resize-none border-0 bg-transparent px-4 pt-3.5 text-[0.9375rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-end gap-3 px-2.5 pb-2.5">
            <span className="text-xs text-muted-foreground">Shift + Enter for a new line</span>
            <Button size="icon" className="size-9 rounded-xl" onClick={send} disabled={!prompt.trim() || waiting || !!paused} aria-label="Send">
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

function Exchange({ message, hostName, memory }: { message: Message; hostName: string; memory: Memory }) {
  const backend = useBackend();
  const { text, suggestions } = splitSuggestions(message.answer ?? "");
  const known = new Set(memory.facts.map((f) => f.text.toLowerCase()));
  // Offer only new facts, and only while memory is on.
  const offers = memory.enabled
    ? suggestions.filter((s) => !known.has(s.toLowerCase()) && !memory.dismissed.includes(s))
    : [];
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-bubble-foreground">
          {message.prompt}
        </div>
      </div>
      <div className="flex gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-full border bg-card">
          <Mark className="h-3.5 w-5" />
        </div>
        <div className="min-w-0 flex-1 pt-1">
          {message.state === "running" ? (
            <div className="flex items-center gap-2.5 text-[0.9375rem] text-muted-foreground">
              <span className="flex gap-1" aria-hidden>
                <span className="typing-dot size-1.5 rounded-full bg-primary" />
                <span className="typing-dot size-1.5 rounded-full bg-primary" />
                <span className="typing-dot size-1.5 rounded-full bg-primary" />
              </span>
              {hostName}'s agent is writing
            </div>
          ) : message.state === "done" ? (
            <>
              <Markdown>{text}</Markdown>
              <div className="mt-2 flex items-center gap-1 text-muted-foreground">
                <CopyButton text={text} className="h-7 px-2 text-xs" />
                <span className="text-xs">{clockTime(message.at)}</span>
              </div>
              {offers.map((fact) => (
                <div key={fact} className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-wait-soft px-3 py-2 text-sm text-wait-ink">
                  <Brain className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    Remember <span className="font-medium">“{fact}”</span>?
                  </span>
                  <Button
                    size="sm"
                    className="h-7"
                    onClick={() => backend.addMemory(fact).then(() => toast.success("Added to memory"), (e) => toast.error(e.message))}
                  >
                    Remember
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-wait-ink hover:bg-transparent hover:underline" onClick={() => backend.dismissSuggestion(fact)}>
                    Not now
                  </Button>
                </div>
              ))}
            </>
          ) : (
            <p className="selectable text-[0.9375rem] text-destructive">{message.error ?? "Something went wrong."}</p>
          )}
        </div>
      </div>
    </div>
  );
}
