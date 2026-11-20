import {
  agentStopAllSummary,
  type StopAllResult,
  type ToastInput,
} from "../../button/index.js";

/** One summary, never a notification per helper. Counts reflect confirmed stops. */
export function stopAllSummary(result: StopAllResult) {
  const summary = agentStopAllSummary(result);
  return summary.tone === "success"
    ? ({ variant: "success", message: summary.message } satisfies ToastInput)
    : ({
        variant: "warning",
        duration: "until-dismissed",
        message: summary.message,
      } satisfies ToastInput);
}

/** A rejected request confirms no stop; keep that unresolved attention visible. */
export function stopAllFailure(cause: unknown) {
  return {
    variant: "warning",
    duration: "until-dismissed",
    message: `Stop-all unconfirmed: 1 request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  } satisfies ToastInput;
}
