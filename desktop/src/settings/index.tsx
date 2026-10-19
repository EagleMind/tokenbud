import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { SettingsSection } from "@/host/types";
import { cn } from "@/lib/utils";
import { Appearance } from "./Appearance";
import { ModelSettings } from "./ModelSettings";
import { RelaySettings } from "./RelaySettings";
import { ReserveSettings } from "./ReserveSettings";

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
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                section === s.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="mt-6 space-y-5">
          {section === "model" && <ModelSettings />}
          {section === "reserve" && <ReserveSettings />}
          {section === "relay" && <RelaySettings />}
          {section === "appearance" && <Appearance />}
        </div>
      </main>
    </div>
  );
}
