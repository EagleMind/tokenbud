import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: React.ReactNode; hint?: React.ReactNode }) {
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

/** A text field that saves on Enter or when you leave it (once, not twice). */
export function SavingInput({ id, value, placeholder, onSave }: { id: string; value: string; placeholder: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  // The value last sent, so Enter followed by leaving the field doesn't save the same thing again.
  const sent = useRef(value);
  useEffect(() => {
    setDraft(value);
    sent.current = value;
  }, [value]);
  const save = () => {
    if (draft !== sent.current) {
      sent.current = draft;
      onSave(draft);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        placeholder={placeholder}
        spellCheck={false}
        className="font-mono text-sm"
      />
    </form>
  );
}

/** Pick a model from what the server or provider lists ("" = the label in `empty`). */
export function ModelSelect({
  id,
  value,
  models,
  empty,
  onChange,
}: {
  id: string;
  value: string;
  models: string[];
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
