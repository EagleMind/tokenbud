import { RadioGroup } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * A group of selectable cards (one choice at a time). Built on Radix RadioGroup, so it behaves
 * like radio buttons: one Tab stop, arrow keys move between cards, screen readers announce it.
 */
export function ChoiceGroup<T extends string>({
  value,
  onChange,
  label,
  className,
  children,
}: {
  value: T;
  onChange: (value: T) => void;
  /** What's being chosen, for screen readers. */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <RadioGroup.Root value={value} onValueChange={(v) => onChange(v as T)} aria-label={label} className={className}>
      {children}
    </RadioGroup.Root>
  );
}

/** One card in a ChoiceGroup. */
export function ChoiceCard({
  value,
  disabled,
  className,
  children,
}: {
  value: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <RadioGroup.Item
      value={value}
      disabled={disabled}
      className={cn(
        "rounded-2xl border bg-card p-4 text-left transition-colors hover:border-primary disabled:opacity-50",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        "data-[state=checked]:border-primary data-[state=checked]:bg-id-card",
        className,
      )}
    >
      {children}
    </RadioGroup.Item>
  );
}
