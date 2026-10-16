import { idleActivity } from "@fungi.computer/parakeet-testing";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import type {
  SessionPendingPrompt,
  SessionSnapshot,
} from "@fungi.computer/shiitake/client";
import { act } from "react";
import { TuiFrame } from "../src/frame.js";
import { createDesignTuiFixture } from "./design-fixture.js";
import { captureCells } from "./frame-cells.js";

/**
 * Stack rule for user blocks: one surface row above and below each text.
 * Consecutive user blocks share one continuous surface (no ground row between
 * them); a ground row still separates a user block from any other row.
 */

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Message = SessionSnapshot["messages"][number];

function user(id: string, sequence: number, content: string): Message {
  return {
    id,
    commandId: id,
    sequence,
    value: { role: "user", content, timestamp: sequence },
  };
}

function assistant(id: string, sequence: number, text: string): Message {
  return {
    id,
    commandId: null,
    sequence,
    value: {
      role: "assistant",
      api: "pi",
      provider: "camel",
      model: "auto",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: sequence,
      usage: zeroUsage,
    },
  };
}

function snapshot(
  messages: Message[],
  prompts: SessionPendingPrompt[] = [],
): SessionSnapshot {
  return {
    pending: { total: prompts.length, prompts, hasMore: false },
    sessionId: "tui-user-stack",
    cursor: "user-stack-cursor",
    hasMore: false,
    oldestCursor: null,
    messages,
    terminals: [],
    compactions: [],
    activity: idleActivity,
    progress: null,
    extensions: {},
    attention: [],
  };
}

async function render(
  messages: Message[],
  height: number,
  prompts: SessionPendingPrompt[] = [],
) {
  const fixture = createDesignTuiFixture({
    snapshot: snapshot(messages, prompts),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        initialTheme="mocha"
      />
    </QueryClientProvider>,
    { width: 60, height },
  );
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("second user message")),
    );
    await act(async () => setup.renderOnce());
    const frame = captureCells(setup);
    const lines = setup.captureCharFrame().split("\n");
    const bg = (x: number, y: number) =>
      frame.cells.find((cell) => cell.x === x && cell.y === y)?.bg.join(",") ??
      "missing";
    const rowOf = (text: string) =>
      lines.findIndex((line) => line.includes(text));
    return { frame, lines, bg, rowOf };
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    client.clear();
    commands.close();
  }
}

test("pending interrupts precede compact cues with distinct theme colours", async () => {
  const view = await render(
    [
      user("first", 1, "first user message"),
      user("second", 2, "second user message"),
    ],
    35,
    [
      {
        commandId: "cue",
        delivery: "followUp",
        text: "Cue pending text\ncontinued with a very long ending that must not wrap onto another row",
      },
      { commandId: "interrupt", delivery: "steer", text: "Interrupt pending" },
    ],
  );
  const interrupt = view.rowOf("Interrupt pending");
  const cue = view.rowOf("Cue pending text");
  expect(interrupt).toBeGreaterThan(view.rowOf("second user message"));
  expect(cue).toBeGreaterThan(interrupt);
  expect(view.lines[cue]).not.toContain("queued");
  expect(view.lines[cue]).toContain("…");
  expect(view.lines[cue]).not.toContain("must not wrap");
  expect(view.lines[cue + 1]).not.toContain("must not wrap");
  const foreground = (text: string, y: number) =>
    view.frame.cells
      .find((cell) => cell.y === y && cell.text === text)
      ?.fg.join(",");
  expect(foreground("I", interrupt)).toBeDefined();
  expect(foreground("I", interrupt)).not.toBe(foreground("C", cue));
});

test("consecutive user messages stack as one continuous surface", async () => {
  const view = await render(
    [
      user("first", 1, "first user message"),
      user("second", 2, "second user message"),
      assistant("reply", 3, "assistant reply to the second message"),
    ],
    30,
  );
  const ground = view.bg(0, 0);
  const first = view.rowOf("first user message");
  const second = view.rowOf("second user message");
  const reply = view.rowOf("assistant reply to the second message");
  const surface = view.bg(0, first);
  expect(surface).not.toBe(ground);

  // ground [pad, text, pad][pad, text, pad] ground reply
  expect(view.bg(0, first - 2)).toBe(ground);
  expect(second - first).toBe(3);
  for (let y = first - 1; y <= second + 1; y += 1)
    expect(view.bg(0, y)).toBe(surface);
  expect(view.bg(0, second + 2)).toBe(ground);
  expect(reply).toBe(second + 3);
});

test("a ground row still separates user blocks from assistant replies", async () => {
  const view = await render(
    [
      assistant("opening", 1, "opening assistant message"),
      user("question", 2, "question user message"),
      assistant("answer", 3, "answer assistant message"),
      user("second", 4, "second user message"),
    ],
    30,
  );
  const ground = view.bg(0, 0);
  const opening = view.rowOf("opening assistant message");
  const question = view.rowOf("question user message");
  const answer = view.rowOf("answer assistant message");
  const surface = view.bg(0, question);
  expect(surface).not.toBe(ground);

  // reply ground [pad, text, pad] ground reply ground [pad, text, pad]
  expect(question - opening).toBe(3);
  expect(view.bg(0, opening + 1)).toBe(ground);
  expect(view.bg(0, question + 2)).toBe(ground);
  expect(answer).toBe(question + 3);
  expect(view.bg(0, answer + 1)).toBe(ground);
  const second = view.rowOf("second user message");
  expect(second).toBe(answer + 3);
  expect(view.bg(0, second + 2)).toBe(ground);
});
