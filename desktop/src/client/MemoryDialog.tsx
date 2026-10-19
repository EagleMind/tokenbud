import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { run } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { MAX_FACT_CHARS, type Memory, useBackend } from "./backend";

/** Your local-first memory: facts that travel with each prompt, kept only on this device. */
export function MemoryDialog({ open, onOpenChange, memory }: { open: boolean; onOpenChange: (o: boolean) => void; memory: Memory }) {
  const backend = useBackend();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Memory</DialogTitle>
          <DialogDescription>
            Things the agent should know about you. Sent with each prompt to the agent you're connected to, and stored only on this device.
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
                    aria-label="Fact"
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
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  aria-label={`Edit: ${f.text}`}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  onClick={() => run(backend.deleteMemory(f.id))}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
            aria-label="New fact"
          />
          <Button type="submit" disabled={!draft.trim()}>
            <Plus /> Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
