import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";

/**
 * The tokenbud mark: two circles, you and your bud, and the part they share (the agent).
 * When `together` turns on (connected, or sharing) the circles slide into each other;
 * that's the app's one ambient animation.
 */
export function Mark({ together = true, className }: { together?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 40 28" aria-hidden className={cn(!together && "mark-apart", className)}>
      <circle className="mark-a" cx="14" cy="14" r="10" fill="var(--periwinkle)" />
      <circle className="mark-b" cx="26" cy="14" r="10" fill="var(--mint)" />
      <path className="mark-overlap" d="M20 6 A10 10 0 0 1 20 22 A10 10 0 0 1 20 6 Z" fill="var(--foreground)" />
    </svg>
  );
}

export function Wordmark({ alive, suffix }: { alive?: boolean; suffix?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <Mark together={alive} className="h-7 w-10" />
      <div className="leading-none">
        <div className="font-display text-[1.25rem] font-semibold tracking-tight">tokenbud</div>
        {suffix && <div className="mt-0.5 text-xs text-muted-foreground">{suffix}</div>}
      </div>
    </div>
  );
}

// Flat pastel tints, picked by name so each person keeps their colour.
const TINTS = [
  "bg-[#e3e5ff] text-[#3a3f9e] dark:bg-[#2e3266] dark:text-[#c3c7ff]",
  "bg-[#d9f6ea] text-[#1f6b4f] dark:bg-[#1d3a31] dark:text-[#9ae6c6]",
  "bg-[#fff3c4] text-[#6e5000] dark:bg-[#3a3216] dark:text-[#f3d77a]",
  "bg-[#ffe1dc] text-[#8a3a2e] dark:bg-[#3d2424] dark:text-[#f5b1a6]",
  "bg-[#f0e3ff] text-[#5e3a8f] dark:bg-[#33264d] dark:text-[#d6bdfa]",
  "bg-[#dcf0ff] text-[#2a5a80] dark:bg-[#1c2f45] dark:text-[#a6d1f5]",
]

function tint(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

export function FriendAvatar({
  name,
  online,
  className,
}: {
  name: string;
  online?: boolean | null;
  className?: string;
}) {
  return (
    <div className="relative shrink-0">
      <Avatar className={cn("size-9", className)}>
        <AvatarFallback className={cn("font-display text-[0.8rem] font-semibold", tint(name))}>
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      {online !== undefined && (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-[var(--sidebar)]",
            online ? "bg-live" : online === false ? "bg-offline" : "bg-transparent ring-0",
          )}
          aria-label={online ? "online" : online === false ? "offline" : undefined}
        />
      )}
    </div>
  );
}
