import { useEffect, useState } from "react";
import { ArrowLeft, Check, Cloud, Cpu, Loader2, Minus, Monitor, Moon, Plus, Server, Sun, TerminalSquare } from "lucide-react";
import { toast } from "sonner";

import { FriendAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Engine, HostState, Provider, Reserve, SettingsSection } from "@/host/types";
import { call, useBackendState } from "@/lib/backend";
import { clockTime } from "@/lib/format";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "reserve", label: "Reserve" },
  { id: "relay", label: "Relay" },
  { id: "appearance", label: "Appearance" },
];

export function Settings({
  section,
  onSection,
  onBack,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onBack: () => void;
}) {
  // Reading the settings must not start sharing: share=false.
  const { state } = useBackendState<HostState>("host_state", "host-changed", { share: false });

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-2xl px-8 py-7">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
            <ArrowLeft />
          </Button>
          <h1 className="font-display text-2xl font-semibold">Settings</h1>
        </div>

        <nav className="mt-5 flex gap-1 border-b" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => onSection(s.id)}
              aria-current={section === s.id ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 px-3 pt-1 pb-2.5 text-sm font-medium transition-colors",
                section === s.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="mt-6 space-y-5">
          {section === "appearance" ? (
            <Appearance />
          ) : section === "relay" ? (
            <RelaySettings />
          ) : !state ? (
            <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
          ) : section === "model" ? (
            <ModelSettings state={state} />
          ) : (
            <ReserveSettings reserve={state.reserve} engine={state.engine} />
          )}
        </div>
      </main>
    </div>
  );
}

// ---------- Model ----------

function ModelSettings({ state }: { state: HostState }) {
  const choices: { engine: Engine; icon: React.ReactNode; title: string; body: string }[] = [
    { engine: "local", icon: <Cpu />, title: "This computer", body: "A local model in Ollama or LM Studio. Free, private." },
    { engine: "provider", icon: <Cloud />, title: "A provider", body: "Anthropic, OpenAI, Google and more, with your own key." },
    ...(state.claude_code_allowed
      ? [{ engine: "claude_code" as const, icon: <TerminalSquare />, title: "Claude Code", body: "Your own login. Development builds only." }]
      : []),
  ];
  const choose = (engine: Engine) =>
    engine === "provider" ? call("set_provider", { provider: state.provider }) : call("set_engine", { engine });

  return (
    <>
      <section>
        <h2 className="text-sm font-medium text-muted-foreground">Where answers come from</h2>
        <div className={cn("mt-3 grid gap-3", choices.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")} role="radiogroup">
          {choices.map((c) => {
            const active = state.engine === c.engine;
            return (
              <button
                key={c.engine}
                role="radio"
                aria-checked={active}
                onClick={() => !active && choose(c.engine)}
                className={cn(
                  "rounded-2xl border p-4 text-left transition-colors [&_svg]:size-5",
                  active ? "border-primary bg-id-card" : "bg-card hover:border-primary",
                )}
              >
                <span className={cn("block", active ? "text-primary" : "text-muted-foreground")}>{c.icon}</span>
                <span className="mt-3 block font-display font-semibold">{c.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{c.body}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-3xl border bg-card p-6">
        {state.engine === "local" && <LocalDetails state={state} />}
        {state.engine === "provider" && <ProviderDetails state={state} />}
        {state.engine === "claude_code" && (
          <p className="text-sm text-muted-foreground">
            Prompts run with <code className="font-mono">claude -p</code> on your own Claude Code login, in an empty folder with no
            tools. Only for testing on your own machine: Anthropic's terms don't allow answering other people's prompts with a
            Claude subscription, so release builds leave this out.
          </p>
        )}
        <EngineStatus check={state.engine_check} />
      </section>
    </>
  );
}

function EngineStatus({ check }: { check: HostState["engine_check"] }) {
  return (
    <div className="mt-5 flex items-center gap-2 border-t pt-4 text-sm">
      {check === null ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Checking…
        </span>
      ) : (
        <>
          <span className={cn("size-2 shrink-0 rounded-full", check.ok ? "bg-live" : "bg-wait")} />
          <span className={cn("selectable", check.ok ? "text-muted-foreground" : "text-wait-ink")}>{check.text}</span>
          <Button variant="link" size="sm" className="ml-auto h-auto p-0" onClick={() => call("check_engine")}>
            Check again
          </Button>
        </>
      )}
    </div>
  );
}

function ModelSelect({
  id,
  value,
  models,
  empty,
  onChange,
}: {
  id: string;
  value: string;
  models: string[];
  /** Label for the "" option. */
  empty: string;
  onChange: (model: string) => void;
}) {
  // Keep a saved model in the list even if it isn't offered (the status line explains).
  const list = value && !models.includes(value) ? [value, ...models] : models;
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <option value="">{empty}</option>
      {list.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** An address field that saves on Enter or when you leave it. */
function SavingInput({ id, value, placeholder, onSave }: { id: string; value: string; placeholder: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (draft !== value) onSave(draft);
      }}
    >
      <Input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onSave(draft)}
        placeholder={placeholder}
        spellCheck={false}
        className="font-mono text-sm"
      />
    </form>
  );
}

function LocalDetails({ state }: { state: HostState }) {
  const save = (patch: { url?: string; model?: string }) =>
    call("set_local", { url: patch.url ?? state.local.url, model: patch.model ?? state.local.model });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Model" htmlFor="local-model">
        <ModelSelect
          id="local-model"
          value={state.local.model}
          models={state.models}
          empty={state.models.length ? `First available (${state.models[0]})` : "No models found"}
          onChange={(model) => save({ model })}
        />
      </Field>
      <Field label="Server" htmlFor="local-url" hint="Leave empty to find Ollama or LM Studio.">
        <SavingInput id="local-url" value={state.local.url} placeholder="localhost:11434" onSave={(url) => save({ url })} />
      </Field>
    </div>
  );
}

function ProviderDetails({ state }: { state: HostState }) {
  const current = state.providers.find((p) => p.id === state.provider) ?? state.providers[0];
  return (
    <>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Provider">
        {state.providers.map((p) => {
          const active = p.id === current.id;
          return (
            <button
              key={p.id}
              role="radio"
              aria-checked={active}
              onClick={() => !active && call("set_provider", { provider: p.id })}
              className={cn(
                "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                active ? "border-primary bg-id-card" : "hover:border-primary",
              )}
            >
              <FriendAvatar name={p.name.replace(/([a-z])([A-Z])/g, "$1 $2")} className="size-7" />
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className={cn("block text-xs", p.has_key ? "text-live" : "text-muted-foreground")}>
                  {p.has_key ? "Key saved" : p.id === "custom" ? "Any compatible API" : "No key"}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-6 space-y-4">
        {current.id === "custom" && (
          <Field label="Address" htmlFor="custom-url" hint="Any OpenAI-compatible API, for example a vLLM or LiteLLM server.">
            <SavingInput
              id="custom-url"
              value={state.custom_url}
              placeholder="https://my-server.example/v1"
              onSave={(url) => call("set_custom_url", { url })}
            />
          </Field>
        )}
        <ProviderKey provider={current} />
        <Field label="Model" htmlFor="provider-model">
          <ModelSelect
            id="provider-model"
            value={current.model}
            models={state.models}
            empty={
              current.default_model
                ? `Default (${current.default_model})`
                : state.models.length
                  ? `First available (${state.models[0]})`
                  : current.has_key || current.id === "custom"
                    ? "No models listed"
                    : "Add a key to see models"
            }
            onChange={(model) => call("set_provider_model", { provider: current.id, model })}
          />
        </Field>
      </div>
    </>
  );
}

function ProviderKey({ provider }: { provider: Provider }) {
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  useEffect(() => {
    setKey("");
    setReplacing(false);
  }, [provider.id, provider.has_key]);
  const optional = provider.id === "custom";

  if (provider.has_key && !replacing) {
    return (
      <Field label="API key" htmlFor="api-key">
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm">
          <Check className="size-4 text-live" />
          <span className="flex-1">Saved in your system keychain</span>
          <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => call("forget_provider_key", { provider: provider.id }).catch((e) => toast.error(e.message))}
          >
            Remove
          </Button>
        </div>
      </Field>
    );
  }
  return (
    <Field
      label={optional ? "API key (if it needs one)" : "API key"}
      htmlFor="api-key"
      hint={provider.key_url ? `Get one at ${provider.key_url}. It's stored in your system keychain.` : "Stored in your system keychain."}
    >
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call("save_provider_key", { provider: provider.id, key });
            toast.success(`${provider.name} key saved`);
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      >
        <Input id="api-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" autoComplete="off" />
        <Button type="submit" disabled={!key.trim()}>
          Save
        </Button>
        {replacing && (
          <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
            Cancel
          </Button>
        )}
      </form>
    </Field>
  );
}

// ---------- Reserve ----------

function ReserveSettings({ reserve, engine }: { reserve: Reserve; engine: Engine }) {
  const save = (patch: Partial<Pick<Reserve, "max_per_hour" | "pause_while_busy">>) =>
    call("set_reserve", {
      maxPerHour: patch.max_per_hour ?? reserve.max_per_hour,
      pauseWhileBusy: patch.pause_while_busy ?? reserve.pause_while_busy,
    });
  const limited = reserve.max_per_hour > 0;
  const step = (n: number) => save({ max_per_hour: Math.min(Math.max(n, 1), 1000) });

  return (
    <section className="rounded-3xl border bg-card p-6">
      <h2 className="font-display text-lg font-semibold">Keep some for yourself</h2>
      <p className="text-sm text-muted-foreground">
        Sharing pauses on its own so you never run short. People stay connected and see when it resumes.
      </p>

      {reserve.paused && (
        <p className="mt-4 rounded-xl bg-wait-soft px-4 py-3 text-sm text-wait-ink">
          {reserve.paused.kind === "limit"
            ? `Paused until ${reserve.paused.until ? clockTime(reserve.paused.until) : "later"}: you've lent your ${reserve.max_per_hour} prompts for this hour.`
            : "Paused while you're using Claude Code. Sharing resumes when you're done."}
        </p>
      )}

      <div className="mt-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <label className="flex items-center gap-3 text-sm font-medium">
            <Switch checked={limited} onCheckedChange={(on) => save({ max_per_hour: on ? 30 : 0 })} />
            Lend at most
          </label>
          {limited ? (
            <div className="flex items-center gap-1 rounded-xl border bg-background p-1">
              <Button variant="ghost" size="icon" className="size-8" onClick={() => step(reserve.max_per_hour - 5)} disabled={reserve.max_per_hour <= 1} aria-label="Fewer prompts per hour">
                <Minus />
              </Button>
              <span className="w-10 text-center font-display text-lg font-semibold tabular-nums">{reserve.max_per_hour}</span>
              <Button variant="ghost" size="icon" className="size-8" onClick={() => step(reserve.max_per_hour + 5)} aria-label="More prompts per hour">
                <Plus />
              </Button>
              <span className="pr-2 pl-1 text-sm text-muted-foreground">an hour</span>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">No limit</span>
          )}
        </div>
        {/* Your own Claude Code use only competes with sharing when sharing runs on Claude Code. */}
        {engine === "claude_code" && (
          <label className="flex items-center gap-3 text-sm font-medium">
            <Switch checked={reserve.pause_while_busy} onCheckedChange={(on) => save({ pause_while_busy: on })} />
            Pause while I'm using Claude Code
          </label>
        )}
      </div>

      <p className="mt-5 text-sm text-muted-foreground">
        {reserve.lent_day === 0
          ? "Nothing lent in the last 24 hours."
          : `Lent ${reserve.lent_hour} in the last hour and ${reserve.lent_day} in the last 24 hours${
              reserve.cost_day > 0 ? `, about $${reserve.cost_day.toFixed(2)} by Claude Code's estimate` : ""
            }.`}
      </p>
    </section>
  );
}

// ---------- Relay ----------

interface RelayState {
  url: string;
  default_url: string;
  custom: boolean;
  from_env: boolean;
}

/** Which relay prompts pass through: tokenbud's public one, or one you run yourself. */
function RelaySettings() {
  const [relay, setRelay] = useState<RelayState | null>(null);
  const [draft, setDraft] = useState("");
  // Showing the "my own relay" form (before one is saved, too).
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () =>
    call<RelayState>("relay_state").then((r) => {
      setRelay(r);
      setOwn(r.custom);
      setDraft(r.custom ? r.url : "");
    });
  useEffect(() => {
    load();
  }, []);
  if (!relay) return <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />;

  const use = async (url: string | null) => {
    setBusy(true);
    try {
      await call("set_relay", { url });
      await load();
      toast.success(url ? "Now using your relay" : "Back on tokenbud's public relay");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const options = [
    { own: false, icon: <Cloud />, title: "tokenbud's public relay", body: "Works out of the box. Free, best effort." },
    { own: true, icon: <Server />, title: "My own relay", body: "Your own Cloudflare Worker. A few minutes to set up, free plan." },
  ];
  const choose = (wantOwn: boolean) => {
    if (wantOwn) {
      setOwn(true);
      setDraft((d) => d || "https://");
    } else if (relay.custom) {
      use(null);
    } else {
      setOwn(false);
    }
  };

  return (
    <>
      <section>
        <h2 className="text-sm font-medium text-muted-foreground">Prompts and answers pass through</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2" role="radiogroup">
          {options.map((o) => {
            const active = o.own === own;
            return (
              <button
                key={o.title}
                role="radio"
                aria-checked={active}
                disabled={busy}
                onClick={() => !active && choose(o.own)}
                className={cn(
                  "rounded-2xl border p-4 text-left transition-colors [&_svg]:size-5",
                  active ? "border-primary bg-id-card" : "bg-card hover:border-primary",
                )}
              >
                <span className={cn("block", active ? "text-primary" : "text-muted-foreground")}>{o.icon}</span>
                <span className="mt-3 block font-display font-semibold">{o.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{o.body}</span>
              </button>
            );
          })}
        </div>
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
                use(draft);
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
          Everyone you share with, and everyone you connect to, has to be on the same relay. Changing it ends your current
          connection, and you get a separate ID on each relay.
        </p>
      </section>
    </>
  );
}

// ---------- Appearance ----------

function Appearance() {
  const { theme, setTheme } = useTheme();
  const options: { value: Theme; label: string; icon: React.ReactNode; swatch: string[] }[] = [
    { value: "light", label: "Light", icon: <Sun />, swatch: ["#f3f4f8", "#ffffff", "#5b63e6"] },
    { value: "dark", label: "Dark", icon: <Moon />, swatch: ["#16172a", "#1f2139", "#8c93ff"] },
    { value: "system", label: "Match system", icon: <Monitor />, swatch: ["#f3f4f8", "#16172a", "#8edfc0"] },
  ];
  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground">Theme</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
        {options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={theme === o.value}
            onClick={() => setTheme(o.value)}
            className={cn(
              "rounded-2xl border p-4 text-left transition-colors [&_svg]:size-4",
              theme === o.value ? "border-primary bg-id-card" : "bg-card hover:border-primary",
            )}
          >
            <span className="flex h-12 overflow-hidden rounded-lg border">
              {o.swatch.map((c) => (
                <span key={c} className="flex-1" style={{ background: c }} />
              ))}
            </span>
            <span className="mt-3 flex items-center gap-2 text-sm font-medium">
              {o.icon}
              {o.label}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
