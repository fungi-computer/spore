import { expect, it } from "vitest";
import {
  sessionDiagnosticLabel,
  sessionStateLabel,
} from "../src/panes/conversation/session-state-label.js";
import type { ParakeetSessionViewState } from "@fungi.computer/parakeet/headless";

it("shows only the Agent's own activity in the status line", () => {
  const states: readonly (readonly [ParakeetSessionViewState, string])[] = [
    [{ kind: "idle" }, "idle"],
    [{ kind: "thinking" }, "thinking"],
    [{ kind: "responding" }, "streaming"],
    [{ kind: "running_tool", tool: "Local_Computer.exec" }, "running a tool"],
    [{ kind: "waiting_for_you" }, "idle"],
    [{ kind: "cancelling" }, "cancelling"],
    [{ kind: "compacting", trigger: "manual" }, "thinking"],
    [{ kind: "connecting" }, "idle"],
    [{ kind: "disconnected", cause: "Session stream closed" }, "failed"],
    [{ kind: "error", cause: "Provider refused" }, "failed"],
    [
      {
        kind: "retrying",
        attempt: 2,
        maxAttempts: 4,
        cause: "503 Service Unavailable",
        nextRetryAt: 10_500,
      },
      "thinking",
    ],
  ];
  for (const [state, label] of states)
    expect(sessionStateLabel(state)).toBe(label);
  expect(sessionStateLabel({ kind: "idle" }, true)).toBe("waiting on you");
  expect(sessionStateLabel({ kind: "waiting_for_you" }, true)).toBe(
    "waiting on you",
  );
  expect(sessionDiagnosticLabel({ kind: "cancelling" })).toBe("cancelling");
});

it("shows the occupant's phase without substituting a queued-message label", () => {
  for (const [runningWork, label] of [
    [null, "idle"],
    [{ phase: "thinking" }, "thinking"],
    [{ phase: "streaming" }, "streaming"],
    [{ phase: "running_tool" }, "running a tool"],
    [{ phase: "waiting_on_you" }, "waiting on you"],
    [{ phase: "cancelling" }, "cancelling"],
  ] as const) {
    const state = {
      kind: "queued",
      queuedCommandId: "next",
      runningWork,
    } as const;
    expect(sessionStateLabel(state)).toBe(label);
    expect(sessionDiagnosticLabel(state)).toBe(sessionStateLabel(state));
  }
});

it("keeps retry detail in structured inspection, not in the status line", () => {
  const retrying = {
    kind: "retrying" as const,
    attempt: 2,
    maxAttempts: 4,
    cause: "503 Service Unavailable",
    nextRetryAt: 10_500,
  };
  expect(sessionDiagnosticLabel(retrying, 8_000)).toBe(
    "retrying 2/4 · 503 Service Unavailable · next in 3s",
  );
  expect(sessionStateLabel(retrying)).toBe("thinking");
});
