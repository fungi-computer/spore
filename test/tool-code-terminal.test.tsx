import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";

test("an unformattable tool call stays in the frame without terminal diagnostics", async () => {
  const source = `const value = ${"[".repeat(4000)}0${"]".repeat(4000)};`;
  const fixture = createTuiFixture({
    messages: [
      {
        id: "formatter-call",
        commandId: null,
        sequence: 1,
        value: {
          role: "assistant",
          api: "pi",
          provider: "fixture",
          model: "fixture",
          content: [
            {
              type: "toolCall",
              id: "formatter-tool",
              name: "execute",
              arguments: { code: source },
            },
          ],
          stopReason: "toolUse",
          timestamp: 1,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
      },
      {
        id: "formatter-result",
        commandId: null,
        sequence: 2,
        value: {
          role: "toolResult",
          toolCallId: "formatter-tool",
          toolName: "execute",
          content: [{ type: "text", text: "fixture tool refused" }],
          isError: true,
          timestamp: 2,
        },
      },
    ],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const writes: unknown[] = [];
  const originalError = console.error;
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  console.error = (...values) => {
    writes.push(values);
  };
  process.stdout.write = process.stderr.write = (chunk) => {
    writes.push(chunk);
    return true;
  };
  let setup: Awaited<ReturnType<typeof testRender>> | undefined;
  try {
    setup = await testRender(
      <QueryClientProvider client={client}>
        <TuiFrame
          commands={commands}
          session={fixture.session}
          initialTheme="mocha"
        />
      </QueryClientProvider>,
      { width: 100, height: 24 },
    );
    const active = setup;
    await act(async () => {
      await active.renderOnce();
      await active.waitForFrame(
        (frame) => frame.includes("]]]]]]]]") && frame.includes("Ask anything"),
      );
    });
    // The renderer's own test output is a captured frame, not process stdio.
    // Wait for the real ScriptCode query, not merely its initial source copy.
    await act(async () => {
      await client.refetchQueries({ queryKey: ["tui-tool-code"] });
      await active.renderOnce();
    });
    const displays = client.getQueriesData({ queryKey: ["tui-tool-code"] });
    expect(displays).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(displays[0]?.[1]).toEqual({
      status: "original",
      content: source,
      reason: "format-unavailable",
    });
    expect(active.captureCharFrame()).not.toContain("fungi operation failed");
  } finally {
    const active = setup;
    if (active !== undefined)
      act(() => {
        active.renderer.destroy();
      });
    client.clear();
    commands.close();
    console.error = originalError;
    process.stdout.write = originalOut;
    process.stderr.write = originalStderr;
  }
});
