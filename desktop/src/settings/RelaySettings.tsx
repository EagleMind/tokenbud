import { useCallback, useEffect, useState } from "react";
import { Cloud, Loader2, Server } from "lucide-react";
import { toast } from "sonner";

import { ChoiceCard, ChoiceGroup } from "@/components/choice";
import { Field } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { call } from "@/lib/backend";
import { errorMessage } from "@/lib/errors";

interface RelayState {
  url: string;
  default_url: string;
  custom: boolean;
  from_env: boolean;
}

/** Which relay prompts pass through: tokenbud's public one, or one you run yourself. */
export function RelaySettings() {
  const [relay, setRelay] = useState<RelayState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Showing the "my own relay" form (before one is saved, too).
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await call<RelayState>("relay_state");
      setRelay(r);
      setLoadError(null);
      setOwn(r.custom);
      setDraft(r.custom ? r.url : "");
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) {
    return (
      <p className="rounded-xl bg-error-soft px-4 py-3 text-sm text-destructive" role="alert">
        Couldn't read the relay setting: {loadError}{" "}
        <button className="underline" onClick={() => void load()}>
          Try again
        </button>
      </p>
    );
  }
  if (!relay) return <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />;

  const use = async (url: string | null) => {
    setBusy(true);
    try {
      await call("set_relay", { url });
      await load();
      toast.success(url ? "Now using your relay" : "Back on tokenbud's public relay");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = (value: string) => {
    if (value === "own") {
      setOwn(true);
      setDraft((d) => d || "https://");
    } else if (relay.custom) {
      void use(null);
    } else {
      setOwn(false);
    }
  };

  return (
    <>
      <section>
        <h2 className="text-sm font-medium text-muted-foreground">Prompts and answers pass through</h2>
        <ChoiceGroup value={own ? "own" : "public"} onChange={choose} label="Relay" className="mt-3 grid gap-3 sm:grid-cols-2">
          <ChoiceCard value="public" disabled={busy} className="group [&_svg]:size-5">
            <span className="block text-muted-foreground group-data-[state=checked]:text-primary">
              <Cloud />
            </span>
            <span className="mt-3 block font-display font-semibold">tokenbud's public relay</span>
            <span className="mt-1 block text-sm text-muted-foreground">Works out of the box. Free, best effort.</span>
          </ChoiceCard>
          <ChoiceCard value="own" disabled={busy} className="group [&_svg]:size-5">
            <span className="block text-muted-foreground group-data-[state=checked]:text-primary">
              <Server />
            </span>
            <span className="mt-3 block font-display font-semibold">My own relay</span>
            <span className="mt-1 block text-sm text-muted-foreground">Your own Cloudflare Worker. A few minutes to set up, free plan.</span>
          </ChoiceCard>
        </ChoiceGroup>
      </section>

      <section className="space-y-4 rounded-3xl border bg-card p-6">
        {relay.from_env && (
          <p className="rounded-xl bg-wait-soft px-4 py-3 text-sm text-wait-ink">
            TOKENBUD_RELAY is set on this computer, so it's used instead of this setting.
          </p>
        )}
        {own ? (
          <Field
            label="Your relay's address"
            htmlFor="relay-url"
            hint="Deploy one from the tokenbud repository with npm run deploy in relay/, then paste the address it prints."
          >
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void use(draft);
              }}
            >
              <Input
                id="relay-url"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="https://tokenbud-relay.you.workers.dev"
                spellCheck={false}
                className="font-mono text-sm"
              />
              <Button type="submit" disabled={busy || draft.replace("https://", "").trim().length < 4 || draft === relay.url}>
                {busy && <Loader2 className="animate-spin" />}
                {busy ? "Checking…" : "Use this relay"}
              </Button>
            </form>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">
            In use: <span className="selectable font-mono">{relay.default_url}</span>
          </p>
        )}
        <p className="border-t pt-4 text-sm text-muted-foreground">
          Everyone you share with, and everyone you connect to, has to be on the same relay. Changing it ends your current connection,
          and you get a separate ID on each relay.
        </p>
      </section>
    </>
  );
}
