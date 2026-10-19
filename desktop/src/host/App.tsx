import { useState } from "react";
import { Link2, Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";

import { FriendAvatar } from "@/components/brand";
import { ConfirmDialog } from "@/components/confirm";
import { CopyButton } from "@/components/shared";
import { Stepper } from "@/components/stepper";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { call, useBackendState } from "@/lib/backend";
import { errorMessage, run } from "@/lib/errors";
import { formatId, timeAgo } from "@/lib/format";
import { pausedForHost } from "@/lib/paused";
import { cn } from "@/lib/utils";
import type { HostState, SettingsSection } from "./types";

const MAX_SEATS = 50;
/** Free seats drawn as empty rows; beyond this they're summed up in a line. */
const FREE_SEATS_SHOWN = 6;

export function HostApp({ onSettings }: { onSettings: (section: SettingsSection) => void }) {
  // Opening host mode starts sharing (the first time per run).
  const state = useBackendState<HostState>("host_state", "host-changed", { share: true });
  if (!state) return null;

  return (
    <div className="h-full overflow-y-auto">
      {/* One column in a narrow window; side by side once there's room (the window keeps its size). */}
      <main className="mx-auto w-full max-w-5xl px-6 py-7 sm:px-8">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-semibold">Share your agent</h1>
          <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
            <StatusLine state={state} />
            <Switch checked={state.status !== "stopped"} onCheckedChange={(on) => run(call("set_sharing", { on }))} aria-label="Share" />
          </label>
        </div>
        <div className="mt-5 grid items-start gap-5 min-[900px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="space-y-5">
            <Credentials state={state} />
            <Summary state={state} onSettings={onSettings} />
          </div>
          <Seats state={state} />
        </div>
      </main>
    </div>
  );
}

function StatusLine({ state }: { state: HostState }) {
  if (state.status === "ready" && state.reserve.paused) {
    return <span className="text-wait-ink">Paused</span>;
  }
  const text = {
    ready: "Sharing",
    connecting: "Connecting…",
    retrying: "Reconnecting…",
    stopped: "Not sharing",
  }[state.status];
  return (
    <span
      title={state.detail ?? undefined}
      aria-live="polite"
      className={cn(
        "flex items-center gap-2",
        state.status === "ready" ? "text-live" : state.status === "stopped" ? "text-muted-foreground" : "text-wait-ink",
      )}
    >
      {(state.status === "connecting" || state.status === "retrying") && <Loader2 className="size-3.5 animate-spin" />}
      {text}
    </span>
  );
}

/** The ID and password: the one thing this window is for. */
function Credentials({ state }: { state: HostState }) {
  const ready = state.status === "ready";
  const [confirmNew, setConfirmNew] = useState(false);
  const newPassword = async () => {
    try {
      await call("new_password");
      if (state.sessions.length) toast("New password. Everyone connected was disconnected.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <section className="rounded-3xl bg-id-card px-8 pt-7 pb-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[0.9375rem] text-muted-foreground">
          Give your ID and password to the people you want to share your agent with. They connect in a browser, nothing to install.
        </p>
        {state.host_id && (
          <CopyButton
            text={`${state.web_url}/#${state.host_id}`}
            label="Copy link"
            icon={<Link2 />}
            className="shrink-0 bg-card hover:bg-card hover:text-primary"
          />
        )}
      </div>
      <div className={cn("mt-6 grid gap-6 sm:grid-cols-[1fr_auto]", !ready && "opacity-45 transition-opacity")}>
        <div>
          <div className="text-sm text-muted-foreground">Your ID</div>
          <div className="selectable mt-1 font-display text-[2.75rem] leading-none font-semibold tracking-tight tabular-nums">
            {state.host_id ? formatId(state.host_id) : "— — —"}
          </div>
        </div>
        <div className="flex items-end">
          {state.host_id && <CopyButton text={formatId(state.host_id)} tooltip="Copy ID" className="hover:bg-card" />}
        </div>
        <div>
          <div className="text-sm text-muted-foreground">Password</div>
          <div className="selectable mt-1 font-mono text-[1.75rem] leading-none font-medium tracking-wider">{state.password}</div>
        </div>
        <div className="flex items-end gap-1">
          <CopyButton text={state.password} tooltip="Copy password" className="hover:bg-card" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="hover:bg-card"
                aria-label="New password"
                onClick={() => (state.sessions.length ? setConfirmNew(true) : void newPassword())}
              >
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New password (disconnects everyone)</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {state.status === "stopped" && <p className="mt-5 text-sm text-muted-foreground">Turn sharing on to let people connect.</p>}
      {state.status === "retrying" && state.detail && <p className="mt-5 text-sm text-wait-ink">Can't reach the relay: {state.detail}</p>}
      <ConfirmDialog
        open={confirmNew}
        onOpenChange={setConfirmNew}
        title="Make a new password?"
        description={`The ${state.sessions.length === 1 ? "person" : `${state.sessions.length} people`} connected now will be disconnected, and need the new password to come back.`}
        confirmLabel="New password"
        onConfirm={() => void newPassword()}
      />
    </section>
  );
}

/** How many people can prompt at once, and who is in a seat right now. */
function Seats({ state }: { state: HostState }) {
  const taken = state.sessions.length;
  const empty = Math.max(state.seats - taken, 0);

  return (
    <section className="rounded-3xl border bg-card px-8 py-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold">People at the same time</h2>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {taken === 0 ? "Nobody is connected." : `${taken} of ${state.seats} seats taken.`} Others wait until a seat is free.
          </p>
        </div>
        <Stepper value={state.seats} onChange={(seats) => run(call("set_seats", { seats }))} min={1} max={MAX_SEATS} label="seats" />
      </div>

      <ul className="mt-5 space-y-2">
        {state.sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded-2xl bg-background px-3 py-2.5">
            <FriendAvatar name={s.name} className="size-8" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{s.name}</div>
              <div className="text-xs text-muted-foreground">
                {s.busy ? <span className="text-primary">Prompting now</span> : `Connected ${timeAgo(s.since)}`}
              </div>
            </div>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => run(call("kick", { sessionId: s.id }))}>
              <X /> Disconnect
            </Button>
          </li>
        ))}
        {Array.from({ length: Math.min(empty, FREE_SEATS_SHOWN) }, (_, i) => (
          <li key={i} className="flex h-[3.25rem] items-center rounded-2xl border border-dashed px-4 text-sm text-muted-foreground">
            Free seat
          </li>
        ))}
        {empty > FREE_SEATS_SHOWN && <li className="px-1 text-sm text-muted-foreground">and {empty - FREE_SEATS_SHOWN} more free seats</li>}
      </ul>
    </section>
  );
}

/** What answers and how much you keep: one line each, with the details in Settings. */
function Summary({ state, onSettings }: { state: HostState; onSettings: (section: SettingsSection) => void }) {
  const r = state.reserve;
  const check = state.engine_check;
  return (
    <section className="divide-y rounded-3xl border bg-card">
      <SummaryRow label="Answers" onChange={() => onSettings("model")} dot={check === null ? "checking" : check.ok ? "live" : "wait"}>
        {check === null ? "Checking…" : check.text}
      </SummaryRow>
      <SummaryRow label="Reserve" onChange={() => onSettings("reserve")} dot={r.paused ? "wait" : undefined}>
        {r.paused
          ? pausedForHost(r.paused, r.max_per_hour)
          : r.max_per_hour > 0
            ? `Lends up to ${r.max_per_hour} prompts an hour. ${r.lent_hour} lent in the last hour.`
            : `No hourly limit. ${r.lent_hour} lent in the last hour.`}
      </SummaryRow>
    </section>
  );
}

function SummaryRow({
  label,
  dot,
  onChange,
  children,
}: {
  label: string;
  dot?: "live" | "wait" | "checking";
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-8 py-4">
      <span className="w-16 shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm" aria-live="polite">
        {dot === "checking" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : dot ? (
          <span className={cn("size-2 shrink-0 rounded-full", dot === "live" ? "bg-live" : "bg-wait")} />
        ) : null}
        <span className={cn("selectable", dot === "wait" && "text-wait-ink")}>{children}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onChange} aria-label={`Change ${label.toLowerCase()}`}>
        Change
      </Button>
    </div>
  );
}
