import { Monitor, Moon, Sun } from "lucide-react";

import { ChoiceCard, ChoiceGroup } from "@/components/choice";
import { type Theme, useTheme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string; icon: React.ReactNode; swatch: string[] }[] = [
  { value: "light", label: "Light", icon: <Sun />, swatch: ["#f3f4f8", "#ffffff", "#5b63e6"] },
  { value: "dark", label: "Dark", icon: <Moon />, swatch: ["#16172a", "#1f2139", "#8c93ff"] },
  { value: "system", label: "Match system", icon: <Monitor />, swatch: ["#f3f4f8", "#16172a", "#8edfc0"] },
];

export function Appearance() {
  const { theme, setTheme } = useTheme();
  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground">Theme</h2>
      <ChoiceGroup value={theme} onChange={setTheme} label="Theme" className="mt-3 grid gap-3 sm:grid-cols-3">
        {OPTIONS.map((o) => (
          <ChoiceCard key={o.value} value={o.value} className="[&_svg]:size-4">
            <span className="flex h-12 overflow-hidden rounded-lg border" aria-hidden>
              {o.swatch.map((c) => (
                <span key={c} className="flex-1" style={{ background: c }} />
              ))}
            </span>
            <span className="mt-3 flex items-center gap-2 text-sm font-medium">
              {o.icon}
              {o.label}
            </span>
          </ChoiceCard>
        ))}
      </ChoiceGroup>
    </section>
  );
}
