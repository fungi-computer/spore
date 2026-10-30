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
    [{ kind: "cancelling" }, "thinking"],
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
});

it("never substitutes a queued message's blocker for Agent state", () => {
  for (const runningWork of [
    null,
    {
      kind: "session",
      sessionId: "session-a",
      commandId: "first",
      title: "Lanes tick",
    },
    { kind: "host", lane: "mail", jobId: "delivery-a" },
  ] as const) {
    const state = {
      kind: "queued",
      queuedCommandId: "next",
      runningWork,
    } as const;
    expect(sessionStateLabel(state)).toBe(
      runningWork === null ? "idle" : "thinking",
    );
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
