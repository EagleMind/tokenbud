import type { Paused } from "@/client/backend";
import { clockTime } from "@/lib/format";

/** Why sharing is paused, said to the host. */
export function pausedForHost(p: Paused, maxPerHour: number): string {
  return p.kind === "limit"
    ? `Paused until ${p.until ? clockTime(p.until) : "later"}: you've lent your ${maxPerHour} prompts for this hour.`
    : "Paused while you're using Claude Code. Sharing resumes when you're done.";
}

/** Why sharing is paused, said to the person connected. */
export function pausedForGuest(p: Paused, hostName: string): string {
  return p.kind === "limit"
    ? `${hostName} paused sharing to keep some for themselves. Back at ${p.until ? clockTime(p.until) : "a later time"}.`
    : `${hostName} paused sharing while they use Claude themselves. It resumes when they're done.`;
}
