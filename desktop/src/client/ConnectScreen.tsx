import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Mark } from "@/components/brand";
import { ThemeToggle } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, run } from "@/lib/errors";
import { formatId } from "@/lib/format";
import { useBackend } from "./backend";

// The browser asks for your name once and remembers it here.
const NAME_KEY = "tokenbud-name";

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function ConnectScreen({ lastId, notice, themeToggle }: { lastId: string; notice: string | null; themeToggle: boolean }) {
  const backend = useBackend();
  const [id, setId] = useState(lastId ? formatId(lastId) : "");
  const [name, setName] = useState(savedName);
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
          localStorage.setItem(NAME_KEY, name.trim());
        } catch {
          /* not remembered; still works */
        }
      }
      await backend.connect(digits, password, name.trim());
    } catch (err) {
      setError(errorMessage(err));
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
        <p className="mt-2 text-[0.9375rem] text-muted-foreground">Enter the ID and password from the person sharing their agent with you.</p>

        {notice && (
          <p className="mt-6 rounded-xl bg-wait-soft px-4 py-3 text-sm text-wait-ink" role="status">
            {notice}
            <button type="button" className="ml-2 underline" onClick={() => run(backend.clearNotice())}>
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
          {error && (
            <p className="rounded-xl bg-error-soft px-4 py-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" className="h-12 w-full text-base" disabled={busy || digits.length !== 9 || !password.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            Connect
          </Button>
        </div>
      </form>
    </div>
  );
}
