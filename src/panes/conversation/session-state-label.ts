import { userFacingCause } from "./user-facing-cause.js";
import {
  sessionStateLabel as ownerStateLabel,
  type ParakeetSessionViewState,
} from "@fungi.computer/parakeet/headless";

/** The status line has one vocabulary; connection/retry detail belongs in inspection. */
export function sessionStateLabel(
  state: ParakeetSessionViewState,
  waitingOnYou = false,
): string {
  switch (state.kind) {
    case "connecting":
      return "idle";
    case "disconnected":
      return "failed";
    default:
      return ownerStateLabel(state, waitingOnYou);
  }
}

/** Structured inspection retains diagnostics without turning queued work into status. */
export function sessionDiagnosticLabel(
  state: ParakeetSessionViewState,
  now = Date.now(),
): string {
  switch (state.kind) {
    case "retrying": {
      const remaining = Math.max(
        0,
        Math.ceil((state.nextRetryAt - now) / 1_000),
      );
      return `retrying ${String(state.attempt)}/${String(state.maxAttempts)} · ${state.cause} · ${remaining === 0 ? "next now" : `next in ${String(remaining)}s`}`;
    }
    case "error":
      return `error: ${userFacingCause(state.cause)}`;
    case "disconnected":
      return `disconnected: ${state.cause} · /reconnect`;
    default:
      return sessionStateLabel(state);
  }
}
