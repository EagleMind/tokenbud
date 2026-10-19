import { useEffect, useState } from "react";
import { Check, Cloud, Cpu, Loader2, TerminalSquare } from "lucide-react";
import { toast } from "sonner";

import { FriendAvatar } from "@/components/brand";
import { ChoiceCard, ChoiceGroup } from "@/components/choice";
import { Field, ModelSelect, SavingInput } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Engine, HostState, Provider } from "@/host/types";
import { call, useBackendState } from "@/lib/backend";
import { errorMessage, run } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** Where answers come from: a local model, a provider with your own key, or (dev builds) Claude Code. */
export function ModelSettings() {
  // Reading the settings must not start sharing: share=false.
  const state = useBackendState<HostState>("host_state", "host-changed", { share: false });
  if (!state) return <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />;

  const choices: { engine: Engine; icon: React.ReactNode; title: string; body: string }[] = [
    { engine: "local", icon: <Cpu />, title: "This computer", body: "A local model in Ollama or LM Studio. Free, private." },
    { engine: "provider", icon: <Cloud />, title: "A provider", body: "Anthropic, OpenAI, Google and more, with your own key." },
    ...(state.claude_code_allowed
      ? [{ engine: "claude_code" as const, icon: <TerminalSquare />, title: "Claude Code", body: "Your own login. Development builds only." }]
      : []),
  ];
  const choose = (engine: Engine) =>
    run(engine === "provider" ? call("set_provider", { provider: state.provider }) : call("set_engine", { engine }));

  return (
    <>
      <section>
        <h2 className="text-sm font-medium text-muted-foreground">Where answers come from</h2>
        <ChoiceGroup
          value={state.engine}
          onChange={choose}
          label="Where answers come from"
          className={cn("mt-3 grid gap-3", choices.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}
        >
          {choices.map((c) => (
            <ChoiceCard key={c.engine} value={c.engine} className="group [&_svg]:size-5">
              <span className="block text-muted-foreground group-data-[state=checked]:text-primary">{c.icon}</span>
              <span className="mt-3 block font-display font-semibold">{c.title}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{c.body}</span>
            </ChoiceCard>
          ))}
        </ChoiceGroup>
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
    <div className="mt-5 flex items-center gap-2 border-t pt-4 text-sm" aria-live="polite">
      {check === null ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Checking…
        </span>
      ) : (
        <>
          <span className={cn("size-2 shrink-0 rounded-full", check.ok ? "bg-live" : "bg-wait")} />
          <span className={cn("selectable", check.ok ? "text-muted-foreground" : "text-wait-ink")}>{check.text}</span>
          <Button variant="link" size="sm" className="ml-auto h-auto p-0" onClick={() => run(call("check_engine"))}>
            Check again
          </Button>
        </>
      )}
    </div>
  );
}

function LocalDetails({ state }: { state: HostState }) {
  const save = (patch: { url?: string; model?: string }) =>
    run(call("set_local", { url: patch.url ?? state.local.url, model: patch.model ?? state.local.model }));
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

/** "OpenAI" -> "Open AI", so monograms differ (OA, OR, DS) instead of all being the first two letters. */
const monogramName = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2");

function ProviderDetails({ state }: { state: HostState }) {
  const current = state.providers.find((p) => p.id === state.provider) ?? state.providers[0];
  if (!current) return <p className="text-sm text-muted-foreground">No providers are available in this build.</p>;

  return (
    <>
      <ChoiceGroup
        value={current.id}
        onChange={(provider) => run(call("set_provider", { provider }))}
        label="Provider"
        className="grid grid-cols-3 gap-2"
      >
        {state.providers.map((p) => (
          <ChoiceCard key={p.id} value={p.id} className="flex items-center gap-2.5 rounded-xl px-3 py-2.5">
            <FriendAvatar name={monogramName(p.name)} className="size-7" />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-medium">{p.name}</span>
              <span className={cn("block text-xs", p.has_key ? "text-live" : "text-muted-foreground")}>
                {p.has_key ? "Key saved" : p.id === "custom" ? "Any compatible API" : "No key"}
              </span>
            </span>
          </ChoiceCard>
        ))}
      </ChoiceGroup>

      <div className="mt-6 space-y-4">
        {current.id === "custom" && (
          <Field label="Address" htmlFor="custom-url" hint="Any OpenAI-compatible API, for example a vLLM or LiteLLM server.">
            <SavingInput
              id="custom-url"
              value={state.custom_url}
              placeholder="https://my-server.example/v1"
              onSave={(url) => run(call("set_custom_url", { url }))}
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
            onChange={(model) => run(call("set_provider_model", { provider: current.id, model }))}
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
      <Field label="API key">
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm">
          <Check className="size-4 text-live" />
          <span className="flex-1">Saved on this computer</span>
          <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => run(call("forget_provider_key", { provider: provider.id }))}
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
            toast.error(errorMessage(err));
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
