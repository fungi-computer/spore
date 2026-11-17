import { expect, test } from "bun:test";
import { sessionStateLabel } from "../src/panes/conversation/session-state-label.js";
import { userFacingCause } from "../src/panes/conversation/user-facing-cause.js";

test("diagnostic codes never reach the user", () => {
  const sentence =
    "No signed-in model provider is available. Use your own Claude or ChatGPT subscription: /login in a Session, or fungi login --provider anthropic --auth-type oauth (Claude) or fungi login --provider openai --auth-type oauth (ChatGPT) in the CLI. For hosted Fungi: fungi login --provider fungi.";
  expect(userFacingCause(`model:rejected: ${sentence}`)).toBe(
    "No signed-in model provider is available. Use /login to sign in with your Claude or ChatGPT subscription, an API key or Fungi, then send your message again.",
  );
  expect(userFacingCause("model:rejected: Model acquisition failed")).toBe(
    "The model couldn't start. Try /retry; if it keeps failing, run fungi doctor.",
  );
  expect(userFacingCause("model:rejected:")).not.toContain("model:rejected");
  expect(userFacingCause("Provider refused")).toBe("Provider refused");
  expect(userFacingCause(null)).toBe("The request did not complete.");
});

test("only a missing signed-in provider suggests signing in", () => {
  for (const sentence of [
    "Model acquisition failed",
    "Model acquisition failed.",
    "Couldn't read your saved sign-in; retry, or run fungi doctor.",
    "Turn provider is not registered; pick another model with /model.",
    "Offline model doesn't support high reasoning; pick another level with /model.",
  ]) {
    expect(userFacingCause(`model:rejected: ${sentence}`)).not.toContain(
      "/login",
    );
  }
  expect(
    userFacingCause(
      "model:rejected: Couldn't read your saved sign-in; retry, or run fungi doctor.",
    ),
  ).toBe("Couldn't read your saved sign-in; retry, or run fungi doctor.");
});

test("a bare acquisition failure offers retry and diagnostics, not login", () => {
  for (const sentence of [
    "Model acquisition failed",
    "Model acquisition failed.",
    "model:rejected: Model acquisition failed.",
    "model:rejected:",
  ]) {
    expect(userFacingCause(sentence)).toBe(
      "The model couldn't start. Try /retry; if it keeps failing, run fungi doctor.",
    );
  }
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

test("a provider usage-limit diagnostic reaches the footer without a retry suggestion", () => {
  expect(
    userFacingCause("OpenAI usage limit reached on your ChatGPT subscription."),
  ).toBe("OpenAI usage limit reached on your ChatGPT subscription.");
  expect(
    userFacingCause(
      "Anthropic usage limit reached on your Claude subscription; resets at 14:30.",
    ),
  ).not.toContain("retry");
});
