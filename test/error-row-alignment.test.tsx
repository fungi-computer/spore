import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { idleActivity } from "@fungi.computer/parakeet-testing";
import { createWhistle } from "@fungi.computer/whistle";
import type { SessionSnapshot } from "@fungi.computer/shiitake/client";
import { TuiFrame } from "../src/frame.js";
import { loadToolSigils } from "../src/tool-sigils.js";
import { createDesignTuiFixture } from "./design-fixture.js";
import { captureFrame } from "./frame-capture.js";
import { captureCells, captureSigilPlacements } from "./frame-cells.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One finished tool call, then a run that stopped with an error and no text. */
const failedRunSnapshot: SessionSnapshot = {
  pending: { total: 0, prompts: [], hasMore: false },
  sessionId: "tui-error-row",
  cursor: "error-row-cursor",
  hasMore: false,
  oldestCursor: null,
  messages: [
    {
      id: "question",
      commandId: "turn",
      sequence: 1,
      value: { role: "user", content: "Search the forage notes", timestamp: 1 },
    },
    {
      id: "call",
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
            id: "search-call",
            name: "execute",
            arguments: { code: 'return await forage.search("morels")' },
          },
        ],
        stopReason: "toolUse",
        timestamp: 2,
        usage: zeroUsage,
      },
    },
    {
      id: "result",
      commandId: null,
      sequence: 3,
      value: {
        role: "toolResult",
        toolCallId: "search-call",
        toolName: "execute",
        content: [{ type: "text", text: "3 notes" }],
        isError: false,
        timestamp: 3,
      },
    },
    {
      id: "failed",
      commandId: null,
      sequence: 4,
      value: {
        role: "assistant",
        api: "pi",
        provider: "camel",
        model: "auto",
        content: [],
        stopReason: "error",
        timestamp: 4,
        usage: zeroUsage,
      },
    },
  ],
  terminals: [],
  compactions: [],
  activity: idleActivity,
  progress: null,
  extensions: {},
  attention: [],
};

for (const width of [80, 160]) {
  test(`the run-error dot shares the tool-row dot column and the gutter shows the error sigil (${String(width)})`, async () => {
    const sigils = await loadToolSigils(() => undefined);
    const fixture = createDesignTuiFixture({ snapshot: failedRunSnapshot });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const commands = createWhistle();
    const setup = await testRender(
      <QueryClientProvider client={client}>
        <TuiFrame
          session={fixture.session}
          commands={commands}
          toolSigils={sigils}
          initialTheme="mocha"
        />
      </QueryClientProvider>,
      { width, height: 30 },
    );
    try {
      await act(async () =>
        setup.waitForFrame((frame) =>
          frame.includes("This run couldn’t finish"),
        ),
      );
      await act(async () => setup.renderOnce());
      await captureFrame(
        setup,
        process.env.TUI_ERROR_ROW_CAPTURE_DIR,
        `error-row-${String(width)}`,
      );
      const frame = captureCells(setup);
      const rowOf = (text: string) =>
        setup
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes(text));
      const toolY = rowOf("forage.search");
      const errorY = rowOf("This run couldn’t finish");
      expect(toolY).toBeGreaterThanOrEqual(0);
      expect(errorY).toBeGreaterThan(toolY);
      const dotX = (y: number) =>
        frame.cells.filter((cell) => cell.y === y && cell.text === "●").at(-1)
          ?.x;
      expect(dotX(toolY)).toBeDefined();
      expect(dotX(errorY)).toBe(dotX(toolY));
      // The tool row's caret sits right after its dot; the error row keeps
      // that cell blank rather than moving its dot.
      const caretX = (dotX(toolY) ?? 0) + 2;
      expect(
        frame.cells.find((cell) => cell.y === toolY && cell.x === caretX)?.text,
      ).toMatch(/[▸▾]/u);
      expect(
        frame.cells.find((cell) => cell.y === errorY && cell.x === caretX)
          ?.text ?? " ",
      ).toBe(" ");

      // Both rows put their sigil in the same gutter cell; the error row's
      // placement is the error image, not a tool image.
      const placements = captureSigilPlacements(frame);
      const toolSigil = placements.find((cell) => cell.y === toolY);
      const errorSigil = placements.find((cell) => cell.y === errorY);
      expect(errorSigil?.x).toBe(toolSigil?.x);
      expect(errorSigil?.fg.slice(0, 3)).toEqual(
        sigils.error.color.toInts().slice(0, 3),
      );
      expect(errorSigil?.fg.slice(0, 3)).not.toEqual(
        sigils.code.color.toInts().slice(0, 3),
      );
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      client.clear();
      commands.close();
      await fixture.waitForClose();
    }
  });
}
