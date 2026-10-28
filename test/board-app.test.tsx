import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { BoardController } from "../src/board/controller.js";
import { BoardApp } from "../src/board/app.js";
import {
  project,
  type BoardProjection,
  type Expanded,
  type SourceRead,
} from "../src/board/model.js";
import { captureFrame } from "./frame-capture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";

const minute = 60_000;
const zero = {
  working: 0,
  waiting_on_you: 0,
  waiting_on_agent: 0,
  stuck: 0,
  failed: 0,
  stopped: 0,
  unavailable: 0,
  idle: 0,
};

function shippedToday(now: number): readonly SourceRead[] {
  const subjects = [
    "feat(thicket): fold insights into the repository Overview board",
    "fix: one tool-call group per run",
    "feat(grove): Open in App from a result card",
    "fix(tui): keep the selection on the same row",
    "docs: the launch board",
  ];
  return [
    {
      sourceId: "git:integration",
      label: "integration/parallel-work-tracking",
      state: "ok",
      readAt: now,
      items: Array.from({ length: 14 }, (_, index) => ({
        id: `landed-${String(index)}`,
        kind: "landed" as const,
        title: subjects[index % subjects.length] ?? "work landed",
        ref: "integration/parallel-work-tracking",
        at: now - (index + 1) * 11 * minute,
      })),
    },
    {
      sourceId: "git:main",
      label: "main",
      state: "ok",
      readAt: now,
      items: [
        {
          id: "release-0.5.0",
          kind: "released" as const,
          title: "0.5.0 released (main)",
          ref: "main",
          at: now - 150 * minute,
        },
      ],
    },
  ];
}

function calm(): BoardProjection {
  const now = Date.now();
  return {
    readAt: now,
    needsYou: [],
    needsYouMore: 0,
    lanes: { shown: [], more: 0, counts: { ...zero, working: 9, idle: 3 } },
    shipping: shippedToday(now),
    expanded: { lanes: false, shipping: false },
  };
}

function busy(
  expanded: Expanded = { lanes: false, shipping: false },
): BoardProjection {
  const now = Date.now();
  return {
    readAt: now,
    needsYou: [
      {
        id: "agent-scout/session-scout/asker/ask-1",
        agentId: "agent-scout",
        agentName: "Scout",
        sessionId: "session-scout",
        sessionTitle: "release prep",
        kind: "question",
        summary: "Which branch?",
        since: now - 12 * minute,
      },
      {
        id: "agent-docs/session-docs/asker/call-1",
        agentId: "agent-docs",
        agentName: "Docs-owner",
        sessionId: "session-docs",
        sessionTitle: "docs pass",
        kind: "approval",
        summary: "Run git push origin docs/x?",
        since: now - 3 * minute,
      },
    ],
    needsYouMore: 0,
    lanes: {
      shown: [
        {
          agentId: "agent-prints",
          name: "Prints-builder",
          sessionId: "session-prints",
          state: "stuck",
          since: now - 41 * minute,
          detail: "staging Stripe key missing",
        },
        {
          agentId: "agent-gate",
          name: "Gate-runner",
          sessionId: "session-gate",
          state: "failed",
          since: now - 95 * minute,
        },
        {
          agentId: "agent-tui",
          name: "Tui-lane",
          sessionId: null,
          state: "unavailable",
          since: null,
        },
      ],
      more: 0,
      counts: {
        ...zero,
        working: 7,
        waiting_on_you: 2,
        waiting_on_agent: 2,
        stuck: 1,
        failed: 1,
        unavailable: 1,
      },
    },
    shipping: [
      ...shippedToday(now),
      {
        sourceId: "npm:@fungi.computer/cli",
        label: "npm: @fungi.computer/cli",
        state: "failed",
        readAt: now - 4 * minute,
        detail: "npm is not installed",
        items: [],
      },
    ],
    expanded,
  };
}

function failed(): BoardProjection {
  return {
    ...calm(),
    readFailure:
      "ENOTDIR: not a directory, stat '.fungi/agents/receipts.sqlite'",
  };
}

/** A controller over a fixed board, remembering what the program asked of it. */
function fixed(first: BoardProjection | undefined) {
  let current = first;
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const controller: BoardController = {
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toggle: (part) => {
      calls.push(`toggle ${part}`);
      if (current !== undefined)
        current = project(
          {
            readAt: current.readAt,
            needs: current.needsYou,
            lanes: current.lanes.shown,
          },
          current.shipping,
          { ...current.expanded, [part]: !current.expanded[part] },
        );
      for (const listener of listeners) listener();
    },
    refresh: () => {
      calls.push("refresh");
    },
    close: () => undefined,
  };
  return { controller, calls };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function mount(
  board: BoardProjection | undefined,
  options: Readonly<{
    width: number;
    height: number;
    theme: "latte" | "mocha";
  }>,
) {
  const { controller, calls } = fixed(board);
  const opened: { agentId: string; sessionId: string }[] = [];
  let quit = 0;
  const setup = await testRender(
    <BoardApp
      controller={controller}
      title="launch"
      theme={options.theme}
      open={(target) => {
        opened.push(target);
        return Promise.resolve(undefined);
      }}
      quit={() => {
        quit += 1;
      }}
    />,
    options,
  );
  closers.push(() => destroyTestRenderer(setup));
  await act(async () => setup.renderOnce());
  return { setup, calls, opened, quits: () => quit };
}

const size = { width: 120, height: 36, theme: "mocha" } as const;

test("calm board is one line", async () => {
  const { setup } = await mount(calm(), size);
  const frame = await waitForFrame(setup, (text) =>
    text.includes("Nothing needs you."),
  );
  expect(frame).toContain(
    "Nothing needs you.  9 working · 14 landed · 1 released today",
  );
  expect(frame).not.toContain("NEEDS YOU");
  expect(frame).not.toContain("STUCK");
  // The heading, the one calm line and the key hints: nothing else is drawn.
  const drawn = frame.split("\n").filter((line) => line.trim() !== "");
  expect(drawn).toHaveLength(3);
});

test("a board still being read says so", async () => {
  const { setup } = await mount(undefined, size);
  await waitForFrame(setup, (text) => text.includes("Reading Agents…"));
});

test("a busy board lists what needs you first, and Enter asks to open the asking conversation", async () => {
  const { setup, opened } = await mount(busy(), size);
  const frame = await waitForFrame(setup, (text) =>
    text.includes("NEEDS YOU 2"),
  );
  expect(frame).toContain("Scout · Which branch?");
  expect(frame).toContain("Docs-owner · Run git push origin docs/x?");
  expect(frame).toContain("question · release prep · 12m");
  expect(frame).toContain("STUCK 3");
  expect(frame).toContain("Prints-builder · stuck: staging Stripe key missing");
  expect(frame).toContain("7 working · 2 waiting on an agent");
  expect(frame).toMatch(/SHIPPED TODAY 15 *\n/u);
  expect(frame).toContain("14 landed · 1 released · + 12 more · s shows");
  expect(frame).toContain(
    "npm is not installed · could not read npm: @fungi.computer/cli",
  );
  expect(frame.indexOf("NEEDS YOU")).toBeLessThan(frame.indexOf("STUCK"));
  expect(frame.indexOf("7 working")).toBeLessThan(
    frame.indexOf("SHIPPED TODAY"),
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressEnter();
  });
  expect(opened).toEqual([
    { agentId: "agent-scout", sessionId: "session-scout" },
  ]);
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressArrow("down");
  });
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressEnter();
  });
  expect(opened.at(-1)).toEqual({
    agentId: "agent-docs",
    sessionId: "session-docs",
  });
});

test("every right column ends on the same cell, with or without a conversation to open", async () => {
  for (const width of [120, 60]) {
    const { setup } = await mount(busy(), { ...size, width, height: 36 });
    const frame = await waitForFrame(setup, (text) =>
      text.includes("NEEDS YOU 2"),
    );
    const ends = frame
      .split("\n")
      .filter((line) => line.includes("●"))
      // Where each age or time ends, with the open hint set aside.
      .map((line) => line.replace(/↵( open)? *$/u, "").trimEnd().length);
    const timed = ends.filter((_, index) => index !== 4);
    expect(timed.length).toBeGreaterThan(5);
    // The unavailable lane has no age; every other row's ends together.
    expect(new Set(timed).size).toBe(1);
  }
});

test("the status dot keeps its tone on the selected row, the title is plain, and an unread source is error-toned apart from the list", async () => {
  const { setup } = await mount(busy(), size);
  await waitForFrame(setup, (text) => text.includes("NEEDS YOU 2"));
  const spans = setup.captureSpans().lines.map((line) => line.spans);
  const span = (text: string) =>
    spans.flat().find((candidate) => candidate.text.includes(text));
  const dots = spans
    .map((line) => line.find((candidate) => candidate.text.includes("●")))
    .filter((dot) => dot !== undefined);
  // The selected first row and the unselected second are both attention.
  expect(dots[0]?.fg.toInts()).toEqual(dots[1]?.fg.toInts());
  expect(dots[0]?.bg.toInts()).not.toEqual(dots[1]?.bg.toInts());
  const error = span("npm is not installed")?.fg.toInts();
  expect(span("Board · launch")?.fg.toInts()).not.toEqual(error);
  expect(span("Board · launch")?.fg.toInts()).toEqual(
    span("Docs-owner · Run git push")?.fg.toInts(),
  );
  expect(error).not.toEqual(span("+ 12 more")?.fg.toInts());
  const text = setup.captureCharFrame().split("\n");
  const problem = text.findIndex((line) => line.includes("npm is not"));
  expect(text[problem - 1]?.trim()).toBe("");
});

test("a narrow calm board keeps its line to one row", async () => {
  const { setup } = await mount(calm(), { ...size, width: 60, height: 24 });
  const frame = await waitForFrame(setup, (text) =>
    text.includes("Nothing needs you."),
  );
  expect(frame).toContain(
    "Nothing needs you.  9 working · 14 landed · 1 released ",
  );
  expect(frame).not.toContain("today");
});

test("a list taller than the terminal leaves room for its scrollbar and says more sits below", async () => {
  const { setup } = await mount(busy({ lanes: false, shipping: true }), {
    ...size,
    width: 60,
    height: 24,
  });
  const frame = await waitForFrame(setup, (text) =>
    text.includes("SHIPPED TODAY 15"),
  );
  const lines = frame.split("\n");
  expect(lines.find((line) => line.includes("Prints-builder"))).toContain(
    "41m  ↵",
  );
  // Rows keep their one-cell inset before the scrollbar's column.
  for (const line of lines.filter((candidate) => candidate.includes("●")))
    expect(line.slice(0, 59).trimEnd().length).toBeLessThanOrEqual(58);
  expect(lines.at(-2) ?? lines.at(-1)).toMatch(/↓ \d+ more\s*$/u);
});

test("keys flip lanes and shipped items, refresh, and quit", async () => {
  const { setup, calls, quits } = await mount(busy(), size);
  await waitForFrame(setup, (text) => text.includes("NEEDS YOU 2"));
  for (const key of ["a", "s", "r"])
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey(key);
    });
  expect(calls).toEqual(["toggle lanes", "toggle shipping", "refresh"]);
  await waitForFrame(setup, (text) => text.includes("ALL LANES"));
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("q");
  });
  expect(quits()).toBe(1);
});

test("a failed read says so instead of drawing a calm board", async () => {
  const { setup } = await mount(failed(), size);
  const frame = await waitForFrame(setup, (text) =>
    text.includes("Could not read the Agents"),
  );
  expect(frame).not.toContain("Nothing needs you.");
});

const shots = process.env.TUI_BOARD_SHOTS;
if (shots !== undefined)
  for (const theme of ["latte", "mocha"] as const)
    for (const [width, height] of [
      [120, 36],
      [60, 24],
    ] as const)
      for (const state of [
        "busy",
        "calm",
        "failed",
        "shippedExpanded",
      ] as const)
        test(`screenshot ${state} ${String(width)}x${String(height)} ${theme}`, async () => {
          mkdirSync(shots, { recursive: true });
          const projections = {
            busy: () => busy(),
            calm,
            failed,
            shippedExpanded: () => busy({ lanes: false, shipping: true }),
          };
          const { setup } = await mount(projections[state](), {
            width,
            height,
            theme,
          });
          await waitForFrame(setup, (text) => text.includes("Board"));
          await captureFrame(
            setup,
            shots,
            `board-${state}-${String(width)}x${String(height)}-${theme}`,
          );
        });
