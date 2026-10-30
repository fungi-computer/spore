import { expect, test } from "bun:test";
import { sessionStateLabel } from "../src/panes/conversation/session-state-label.js";
import { userFacingCause } from "../src/panes/conversation/user-facing-cause.js";

test("diagnostic codes never reach the user", () => {
  const sentence =
    "No signed-in model provider is available. Use your own Claude or ChatGPT subscription: /login in a Session, or fungi login --provider anthropic --auth-type oauth (Claude) or fungi login --provider openai --auth-type oauth (ChatGPT) in the CLI. For hosted Fungi: fungi login --provider fungi.";
  expect(userFacingCause(`model:rejected: ${sentence}`)).toBe(sentence);
  expect(userFacingCause("model:rejected: Model acquisition failed")).toBe(
    "No model is available. Run /login to sign in, then pick a model with /model.",
  );
  expect(userFacingCause("model:rejected:")).not.toContain("model:rejected");
  expect(userFacingCause("Provider refused")).toBe("Provider refused");
  expect(userFacingCause(null)).toBe("The request did not complete.");
});

test("the status line leaves the stopped reason in the transcript", () => {
  const label = sessionStateLabel({
    kind: "error",
    cause: "model:rejected: No signed-in model provider is available.",
  });
  expect(label).toBe("failed");
});

test("retry and disconnect causes stay out of the status line", () => {
  expect(
    sessionStateLabel({
      kind: "retrying",
      cause: "model:unavailable: Try again.",
      attempt: 1,
      maxAttempts: 3,
      nextRetryAt: 2000,
    }),
  ).toBe("thinking");
  expect(
    sessionStateLabel({
      kind: "disconnected",
      cause: "session:closed: Connection lost.",
    }),
  ).toBe("failed");
});
