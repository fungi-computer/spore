import { terminalText } from "../../button/index.js";
import { userFacingCause } from "./user-facing-cause.js";
import {
  queuedSessionLabel,
  type ParakeetSessionViewState,
} from "@fungi.computer/parakeet/headless";

/** Complete labels for a footer that cannot fit the detailed owner state. */
export function compactSessionStateLabel(
  state: ParakeetSessionViewState,
): string {
  switch (state.kind) {
    case "queued":
      return "queued";
    case "waiting_for_you":
      return "idle";
    case "responding":
    case "running_tool":
      return "streaming";
    case "disconnected":
      return "offline";
    case "cancelling":
      return "cancelling…";
    default:
      return state.kind;
  }
}

/** Diagnostic label retained verbatim by the structured Session status contract. */
export function sessionDiagnosticLabel(
  state: ParakeetSessionViewState,
  now = Date.now(),
): string {
  switch (state.kind) {
    case "cancelling":
      return "cancelling…";
    case "retrying": {
      const remaining = Math.max(
        0,
        Math.ceil((state.nextRetryAt - now) / 1_000),
      );
      return `retrying ${String(state.attempt)}/${String(state.maxAttempts)} · ${state.cause} · ${remaining === 0 ? "next now" : `next in ${String(remaining)}s`}`;
    }
    case "responding":
    case "running_tool":
      return "streaming";
    case "queued":
      return terminalText(queuedSessionLabel(state)).replace(/^./u, (letter) =>
        letter.toLowerCase(),
      );
    case "waiting_for_you":
      return "idle";
    case "error":
      return `error: ${userFacingCause(state.cause)}`;
    case "disconnected":
      return `disconnected: ${state.cause} · /reconnect`;
    default:
      return state.kind;
  }
}

/** Footer text: the transcript carries the stopped reason once. */
export function sessionStateLabel(
  state: ParakeetSessionViewState,
  now = Date.now(),
): string {
  switch (state.kind) {
    case "error":
      return "stopped";
    case "retrying":
    case "disconnected":
      return sessionDiagnosticLabel(
        { ...state, cause: userFacingCause(state.cause) },
        now,
      );
    default:
      return sessionDiagnosticLabel(state, now);
  }
}
