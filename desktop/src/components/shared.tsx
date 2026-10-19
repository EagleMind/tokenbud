import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Monitor, Moon, Sun } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-answer selectable", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "ghost",
  size = "sm",
  className,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  variant?: "ghost" | "outline" | "secondary" | "default";
  size?: "sm" | "default" | "icon";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          toast.error("Couldn't reach the clipboard. Select the text and copy it instead.");
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
      {size !== "icon" && (copied ? copiedLabel : label)}
    </Button>
  );
}

const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL: Record<Theme, string> = { system: "Match system", light: "Light", dark: "Dark" };

/** Cycles light, dark, and match system. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-8 text-muted-foreground", className)}
      onClick={() => setTheme(NEXT_THEME[theme])}
      aria-label={`Appearance: ${THEME_LABEL[theme]}`}
      title={`Appearance: ${THEME_LABEL[theme]}`}
    >
      <Icon />
    </Button>
  );
}
