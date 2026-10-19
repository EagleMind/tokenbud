import { toast } from "sonner";

/** A message for people, whatever was thrown. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Something went wrong.";
}

/** Run a backend call from a click or change: failures show as a toast instead of vanishing. */
export function run(p: Promise<unknown>): void {
  p.catch((e: unknown) => toast.error(errorMessage(e)));
}
