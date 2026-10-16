import assert from "node:assert/strict";
import process from "node:process";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "@fungi.computer/spore/frame";
import { createTuiFixture } from "./fixture.js";

const messages = [
  {
    id: "mismatch-user",
    commandId: "mismatch-request",
    sequence: 1,
    value: { role: "user", content: "Fix mismatch.txt", timestamp: 1 },
  },
  {
    id: "mismatch-call",
    commandId: null,
    sequence: 2,
    value: {
      role: "assistant",
      api: "pi",
      provider: "camel",
      model: "auto",
      content: [
        {
          type: "toolCall",
          id: "mismatch-patch",
          name: "apply_patch",
          arguments: {
            patch:
              "*** Begin Patch\n*** Update File: mismatch.txt\n@@\n-beto\n+fixed\n*** End Patch\n",
          },
        },
      ],
      stopReason: "toolUse",
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  },
  {
    id: "mismatch-result",
    commandId: null,
    sequence: 3,
    value: {
      role: "toolResult",
      toolCallId: "mismatch-patch",
      toolName: "apply_patch",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "failed",
            exitCode: 23,
            stdout: "",
            stderr:
              "Patch hunk does not match mismatch.txt.\nExpected hunk:\n  beto\nClosest actual lines:\n  2: beta\nRefresh this hunk from the current file and retry.",
            truncated: false,
            error: { kind: "mismatch" },
          }),
        },
      ],
      isError: true,
      timestamp: 3,
    },
  },
];

const fixture = createTuiFixture({ messages });
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const commands = createWhistle();
const setup = await testRender(
  createElement(
    QueryClientProvider,
    { client },
    createElement(TuiFrame, { commands, session: fixture.session }),
  ),
  { width: 100, height: 24 },
);
try {
  await act(async () => {
    await setup.renderOnce();
    await setup.waitForFrame((frame) =>
      frame.includes("Patch hunk does not match mismatch.txt"),
    );
  });
  const frame = setup.captureCharFrame();
  assert.match(frame, /Patch hunk does not match mismatch\.txt/u);
  assert.match(frame, /2: beta/u);
  assert.doesNotMatch(frame, /CorrectnessError|ComputeReplacements/u);
} finally {
  await act(async () => setup.renderer.destroy());
  client.clear();
  commands.close();
}
process.stdout.write("patch mismatch native TUI proof: pass\n");
