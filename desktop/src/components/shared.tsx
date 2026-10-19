import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Monitor, Moon, Sun } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Answers come from someone else's model, so they're treated as untrusted: no raw HTML (the
 * default), links open outside the app, and images become links instead of loading (a remote
 * image would tell its server you read the answer).
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-answer selectable", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          img: ({ src, alt }) => (
            <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer noopener">
              {alt ? `Image: ${alt}` : "Image"}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const COPIED_MS = 1500;

/**
 * Copies `text`. With `label` it's a small text button; without, an icon button whose tooltip
 * is `tooltip`. It only says "Copied" when copying actually worked.
 */
export function CopyButton({
  text,
  label,
  tooltip = "Copy",
  icon,
  className,
}: {
  text: string;
  label?: string;
  tooltip?: string;
  icon?: React.ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      toast.error("Couldn't reach the clipboard. Select the text and copy it instead.");
    }
  };
  const glyph = copied ? <Check className="text-live" /> : (icon ?? <Copy />);

  if (label) {
    return (
      <Button variant="ghost" size="sm" className={className} onClick={copy}>
        {glyph}
        {copied ? "Copied" : label}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className={className} onClick={copy} aria-label={tooltip}>
          {glyph}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : tooltip}</TooltipContent>
    </Tooltip>
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
