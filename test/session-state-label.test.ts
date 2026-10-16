import { expect, it } from "vitest";

import {
  compactSessionStateLabel,
  sessionStateLabel,
} from "../src/panes/conversation/session-state-label.js";

it("labels owner and disconnected Session states with useful detail", () => {
  expect(sessionStateLabel({ kind: "thinking" })).toBe("thinking");
  expect(sessionStateLabel({ kind: "cancelling" })).toBe("cancelling…");
  expect(
    sessionStateLabel({
      kind: "queued",
      queuedCommandId: "queued-command",
      runningWork: null,
    }),
  ).toBe("queued for host");
  expect(
    sessionStateLabel({ kind: "running_tool", tool: "Local_Computer.exec" }),
  ).toBe("streaming");
  expect(sessionStateLabel({ kind: "waiting_for_you" })).toBe("idle");
  // The transcript carries the stopped reason; the footer does not repeat it.
  expect(sessionStateLabel({ kind: "error", cause: "Provider refused" })).toBe(
    "stopped",
  );
  expect(
    sessionStateLabel({
      kind: "disconnected",
      cause: "Session stream closed",
    }),
  ).toBe("disconnected: Session stream closed · /reconnect");
});

it("shows retry cause, attempt limit, and time until the next try", () => {
  const retrying = {
    kind: "retrying" as const,
    attempt: 2,
    maxAttempts: 4,
    cause: "503 Service Unavailable",
    nextRetryAt: 10_500,
  };
  expect(sessionStateLabel(retrying, 8_000)).toBe(
    "retrying 2/4 · 503 Service Unavailable · next in 3s",
  );
  expect(sessionStateLabel(retrying, 11_000)).toBe(
    "retrying 2/4 · 503 Service Unavailable · next now",
  );
});

it("uses complete readable compact states instead of machine enum names", () => {
  expect(compactSessionStateLabel({ kind: "waiting_for_you" })).toBe("idle");
  expect(
    compactSessionStateLabel({
      kind: "running_tool",
      tool: "Local_Computer.exec",
    }),
  ).toBe("streaming");
  expect(
    compactSessionStateLabel({
      kind: "queued",
      queuedCommandId: "waiting",
      runningWork: null,
    }),
  ).toBe("queued");
  expect(
    compactSessionStateLabel({ kind: "disconnected", cause: "Stream closed" }),
  ).toBe("offline");
  expect(compactSessionStateLabel({ kind: "responding" })).toBe("streaming");
});

it("leaves retry cause words whole for the footer layout to fit", () => {
  const cause =
    "The provider is temporarily unavailable while it completes maintenance";
  expect(
    sessionStateLabel(
      {
        kind: "retrying",
        attempt: 1,
        maxAttempts: 3,
        cause,
        nextRetryAt: 1000,
      },
      0,
    ),
  ).toContain(cause);
});

it("collapses only the requested presentation states in both label sizes", () => {
  for (const label of [sessionStateLabel, compactSessionStateLabel]) {
    expect(label({ kind: "idle" })).toBe("idle");
    expect(label({ kind: "waiting_for_you" })).toBe("idle");
    expect(label({ kind: "thinking" })).toBe("thinking");
    expect(label({ kind: "responding" })).toBe("streaming");
    expect(label({ kind: "running_tool", tool: "execute" })).toBe("streaming");
  }
});

it("names the Session or host job occupying the executor", () => {
  expect(
    sessionStateLabel({
      kind: "queued",
      queuedCommandId: "next",
      runningWork: {
        kind: "session",
        sessionId: "session-a",
        commandId: "first",
      },
    }),
  ).toBe("waiting for Session session-a");
  expect(
    sessionStateLabel({
      kind: "queued",
      queuedCommandId: "next",
      runningWork: { kind: "host", lane: "mail", jobId: "delivery-a" },
    }),
  ).toBe("waiting for host job mail · delivery-a");
});
