import { expect, test } from "bun:test";
import type { ParakeetPromptResult } from "@fungi.computer/parakeet/headless";
import type { PaneSession } from "../src/button/index.js";

function paneCommandResult(
  result: Awaited<ReturnType<PaneSession["command"]>>,
) {
  return result;
}

test("the pane command contract preserves recorded prompts without inventing Agent admission", () => {
  const recorded: ParakeetPromptResult = { status: "recorded" };
  const accepted: ParakeetPromptResult = {
    status: "accepted",
    commandId: "owner-issued-command",
  };
  expect(paneCommandResult(recorded)).toBe(recorded);
  expect(paneCommandResult(accepted)).toBe(accepted);
});
