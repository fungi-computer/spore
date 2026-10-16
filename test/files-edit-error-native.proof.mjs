import assert from "node:assert/strict";
import process from "node:process";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "@fungi.computer/spore/frame";
import { createTuiFixture } from "./fixture.js";

const fixture = createTuiFixture({
  messages: [
    {
      id: "edit-user",
      commandId: "edit-request",
      sequence: 1,
      value: { role: "user", content: "Edit client.js", timestamp: 1 },
    },
    {
      id: "edit-call",
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
            id: "edit-failure-call",
            name: "execute",
            arguments: {
              code: 'return await files.edit({ path: "client.js", oldText: "missing", newText: "fixed" });',
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
      id: "edit-result",
      commandId: null,
      sequence: 3,
      value: {
        role: "toolResult",
        toolCallId: "edit-failure-call",
        toolName: "execute",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "failed",
              error: {
                kind: "not-found",
                path: "client.js",
                message:
                  "Files edit not-found: Old text was not found; read the current file and include exact nearby lines (client.js)",
              },
            }),
          },
        ],
        isError: false,
        timestamp: 3,
      },
    },
  ],
});
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
    await setup.waitForFrame((frame) => frame.includes("Files edit not-found"));
  });
  const frame = setup.captureCharFrame();
  assert.match(frame, /Files edit not-found/u);
  assert.match(frame, /client\.js/u);
  assert.doesNotMatch(frame, /Capability operation failed/u);
} finally {
  await act(async () => setup.renderer.destroy());
  client.clear();
  commands.close();
}
process.stdout.write("Files edit typed error native TUI proof: pass\n");
