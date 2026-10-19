import { Loader2 } from "lucide-react";

import { Stepper } from "@/components/stepper";
import { Switch } from "@/components/ui/switch";
import type { HostState, Reserve } from "@/host/types";
import { call, useBackendState } from "@/lib/backend";
import { run } from "@/lib/errors";
import { pausedForHost } from "@/lib/paused";

const MAX_PER_HOUR = 1000;
const DEFAULT_LIMIT = 30;
// The limit you had before switching it off, so switching it back on restores it.
const LAST_LIMIT_KEY = "tokenbud-last-limit";

function lastLimit(): number {
  try {
    return Number(localStorage.getItem(LAST_LIMIT_KEY)) || DEFAULT_LIMIT;
  } catch {
    return DEFAULT_LIMIT;
  }
}

function rememberLimit(n: number) {
  try {
    localStorage.setItem(LAST_LIMIT_KEY, String(n));
  } catch {
    /* not remembered; the default is used next time */
  }
}

/** 1, 5, 10, 15, …: fine steps at the bottom, fives above. */
const nextLimit = (v: number, d: 1 | -1) => (d > 0 ? (v < 5 ? 5 : v + 5) : v <= 5 ? 1 : v - 5);

/** What you keep for yourself: tokenbud stops lending before it can leave you short. */
export function ReserveSettings() {
  const state = useBackendState<HostState>("host_state", "host-changed", { share: false });
  if (!state) return <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />;
  const { reserve, engine } = state;

  const save = (patch: Partial<Pick<Reserve, "max_per_hour" | "pause_while_busy">>) =>
    run(
      call("set_reserve", {
        maxPerHour: patch.max_per_hour ?? reserve.max_per_hour,
        pauseWhileBusy: patch.pause_while_busy ?? reserve.pause_while_busy,
      }),
    );
  const limited = reserve.max_per_hour > 0;
  const toggleLimit = (on: boolean) => {
    if (!on) rememberLimit(reserve.max_per_hour);
    save({ max_per_hour: on ? lastLimit() : 0 });
  };

  return (
    <section className="rounded-3xl border bg-card p-6">
      <h2 className="font-display text-lg font-semibold">Keep some for yourself</h2>
      <p className="text-sm text-muted-foreground">
        Sharing pauses on its own so you never run short. People stay connected and see when it resumes.
      </p>

      {reserve.paused && (
        <p className="mt-4 rounded-xl bg-wait-soft px-4 py-3 text-sm text-wait-ink" role="status">
          {pausedForHost(reserve.paused, reserve.max_per_hour)}
        </p>
      )}

      <div className="mt-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <label className="flex items-center gap-3 text-sm font-medium">
            <Switch checked={limited} onCheckedChange={toggleLimit} />
            Lend at most
          </label>
          {limited ? (
            <Stepper
              value={reserve.max_per_hour}
              onChange={(n) => save({ max_per_hour: n })}
              min={1}
              max={MAX_PER_HOUR}
              label="prompts an hour"
              suffix="an hour"
              next={nextLimit}
            />
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
