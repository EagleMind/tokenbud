import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Brain } from "lucide-react";
import { toast } from "sonner";

import { Mark } from "@/components/brand";
import { CopyButton, Markdown } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { clockTime } from "@/lib/format";
import { pausedForGuest } from "@/lib/paused";
import { type Chat, type Memory, type Message, type Paused, splitSuggestions, useBackend } from "./backend";

export function ChatPane({
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

  // Suggestions worth offering: new facts only, and only while memory is on. Worked out once
  // per change, not per message.
  const known = useMemo(() => new Set(memory.facts.map((f) => f.text.toLowerCase())), [memory.facts]);
  const offerable = useMemo(
    () => (fact: string) => memory.enabled && !known.has(fact.toLowerCase()) && !memory.dismissed.includes(fact),
    [memory.enabled, memory.dismissed, known],
  );

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
      toast.error(errorMessage(e));
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-8 py-10" role="log" aria-live="polite" aria-label="Conversation">
          {messages.length === 0 ? (
            <div className="py-16 text-center">
              <Mark className="mx-auto h-12 w-[4.25rem]" />
              <h2 className="mt-4 text-xl font-semibold">Ask {hostName}'s agent anything</h2>
              <p className="mx-auto mt-2 max-w-sm text-[0.9375rem] text-muted-foreground">It runs on their computer and only sees what you write here.</p>
            </div>
          ) : (
            messages.map((m, i) => <Exchange key={i} message={m} hostName={hostName} offerable={offerable} />)
          )}
        </div>
      </div>

      <div className="px-8 pb-6">
        {paused && (
          <p className="mx-auto mb-3 max-w-3xl rounded-xl bg-wait-soft px-4 py-2.5 text-sm text-wait-ink" role="status">
            {pausedForGuest(paused, hostName)}
          </p>
        )}
        <div className="mx-auto max-w-3xl rounded-2xl border bg-card focus-within:border-primary">
          <Textarea
            ref={input}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line, and Enter while composing text (Chinese,
              // Japanese, Korean input) finishes the composition instead of sending.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={chat ? "Reply…" : `Message ${hostName}'s agent`}
            aria-label={chat ? "Reply" : `Message ${hostName}'s agent`}
            className="max-h-64 min-h-[3.5rem] resize-none border-0 bg-transparent px-4 pt-3.5 text-[0.9375rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-end gap-3 px-2.5 pb-2.5">
            <span className="text-xs text-muted-foreground">Shift + Enter for a new line</span>
            <Button size="icon" className="size-9 rounded-xl" onClick={() => void send()} disabled={!prompt.trim() || waiting || !!paused} aria-label="Send">
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

/** One prompt and its answer. Memoized: answers are Markdown, and re-parsing them all on every update adds up. */
const Exchange = memo(function Exchange({
  message,
  hostName,
  offerable,
}: {
  message: Message;
  hostName: string;
  offerable: (fact: string) => boolean;
}) {
  const backend = useBackend();
  const { text, suggestions } = useMemo(() => splitSuggestions(message.answer ?? ""), [message.answer]);
  const offers = suggestions.filter(offerable);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-bubble-foreground">
          {message.prompt}
        </div>
      </div>
      <div className="flex gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-full border bg-card" aria-hidden>
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
                <CopyButton text={text} label="Copy" className="h-7 px-2 text-xs" />
                <span className="text-xs">{clockTime(message.at)}</span>
              </div>
              {offers.map((fact) => (
                <div key={fact} className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-wait-soft px-3 py-2 text-sm text-wait-ink">
                  <Brain className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    Remember <span className="font-medium">“{fact}”</span>?
                  </span>
                  <Button
                    size="sm"
                    className="h-7"
                    onClick={() => backend.addMemory(fact).then(() => toast.success("Added to memory"), (e: unknown) => toast.error(errorMessage(e)))}
                  >
                    Remember
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-wait-ink hover:bg-transparent hover:underline"
                    onClick={() => backend.dismissSuggestion(fact).catch((e: unknown) => toast.error(errorMessage(e)))}
                  >
                    Not now
                  </Button>
                </div>
              ))}
            </>
          ) : (
            <p className="selectable text-[0.9375rem] text-destructive" role="alert">
              {message.error ?? "Something went wrong."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
});
