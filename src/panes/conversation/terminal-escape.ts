import type { ParakeetStatus } from "@fungi.computer/parakeet/headless";

/** What the next Esc does. */
export type TerminalEscape = Readonly<{
  kind: "interaction" | "active" | "notice" | "none";
}>;

/** One owner decision supplies the next Esc effect. */
export function nextTerminalEscape(
  input: Readonly<{
    interaction: "prompt" | "actions" | null;
    queued: boolean;
    status: ParakeetStatus;
    cancellationPending: boolean;
    waitingLabel: string | undefined;
    notice?: boolean;
  }>,
): TerminalEscape {
  if (input.interaction !== null) return { kind: "interaction" };
  if (input.cancellationPending || input.status === "cancelling")
    return { kind: "none" };
  if (["sending", "thinking", "streaming", "retrying"].includes(input.status))
    return { kind: "active" };
  if (input.notice) return { kind: "notice" };
  return { kind: "none" };
}
