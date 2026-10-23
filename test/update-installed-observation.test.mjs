import assert from "node:assert/strict";
import { test } from "node:test";
import { hasLiveReplacementDraft } from "./fixtures/update-installed-observation.mjs";

const draft = "Unsubmitted before update plus newer typing";
const sessionId = "session-proof";
const buildId = "replacement-build";
const invocations = ["previous-build", buildId].map((build) => ({
  build,
  args: ["/isolated/dist/cli.js", "sessions", "resume", sessionId],
}));
const evidence = { invocations, draft, sessionId, buildId };
const terminalFrame = (status) =>
  `Start a conversation.\n › ${draft}\n\n ● ${status}   `;

test("a replacement with a hydrated draft never qualifies while its observation remains connecting", () => {
  const frame = terminalFrame("connecting");
  // The original proof accepted exactly this state.
  assert.equal(
    invocations.length === 2 &&
      frame.includes(draft) &&
      !frame.includes("Restart to update"),
    true,
  );
  assert.equal(hasLiveReplacementDraft({ ...evidence, frame }), false);
});

test("the ordinary positive idle footer qualifies the same Session and new launcher", () => {
  assert.equal(
    hasLiveReplacementDraft({ ...evidence, frame: terminalFrame("idle") }),
    true,
  );
});

test("disconnected, blank, or draft-only frames cannot replace live evidence", () => {
  for (const frame of [terminalFrame("disconnected"), "", ` › ${draft}`])
    assert.equal(hasLiveReplacementDraft({ ...evidence, frame }), false);
});

test("a live footer cannot qualify another Session or the previous launcher build", () => {
  const live = { ...evidence, frame: terminalFrame("idle") };
  assert.equal(
    hasLiveReplacementDraft({ ...live, sessionId: "another-session" }),
    false,
  );
  assert.equal(
    hasLiveReplacementDraft({ ...live, buildId: "previous-build" }),
    false,
  );
});
