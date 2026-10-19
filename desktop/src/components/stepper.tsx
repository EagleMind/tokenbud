import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

/** A number with − and + buttons. `next(value, direction)` decides the step (default ±1). */
export function Stepper({
  value,
  onChange,
  min,
  max,
  label,
  suffix,
  next = (v, d) => v + d,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  /** What the number is, for screen readers ("seats", "prompts an hour"). */
  label: string;
  suffix?: string;
  next?: (value: number, direction: 1 | -1) => number;
}) {
  const step = (d: 1 | -1) => onChange(Math.min(Math.max(next(value, d), min), max));
  return (
    <div className="flex items-center gap-1 rounded-xl border bg-background p-1" role="group" aria-label={label}>
      <Button variant="ghost" size="icon" className="size-8" onClick={() => step(-1)} disabled={value <= min} aria-label={`Fewer ${label}`}>
        <Minus />
      </Button>
      <span className="min-w-8 px-1 text-center font-display text-lg font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <Button variant="ghost" size="icon" className="size-8" onClick={() => step(1)} disabled={value >= max} aria-label={`More ${label}`}>
        <Plus />
      </Button>
      {suffix && <span className="pr-2 pl-1 text-sm text-muted-foreground">{suffix}</span>}
    </div>
  );
}
