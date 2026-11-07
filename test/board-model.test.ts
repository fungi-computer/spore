import { expect, test } from "bun:test";
import type {
  SessionAttention,
  SessionSummaryRow,
} from "@fungi.computer/shiitake/client";
import type { BoardAgent } from "@fungi.computer/truffle/board-agents";
import {
  failedRows,
  project,
  readRows,
  type Expanded,
} from "../src/board/model.js";
import { boardView } from "../src/board/view.js";

const now = new Date(2026, 9, 27, 14, 0, 0).getTime();
const minute = 60_000;
const collapsed: Expanded = { lanes: false, shipping: false };

function row(
  sessionId: string,
  state: "needs_you" | "running" | "errored" | "done",
  options: Readonly<{ title?: string; at?: number }> = {},
): SessionSummaryRow {
  const at = options.at ?? now - 5 * minute;
  const base = {
    sessionId,
    title: options.title ?? "work",
    createdAt: 0,
    lastActivityAt: at,
  };
  return state === "errored" || state === "done"
    ? { ...base, state, settledAt: at }
    : { ...base, state };
}

function item(
  kind: string,
  summary: string,
  since: number,
  routed = false,
): SessionAttention {
  const base = { extensionId: "asker", id: kind, kind, summary, since };
  return routed ? { ...base, inbox: false as const } : base;
}

function agent(
  agentId: string,
  sessions: readonly SessionSummaryRow[],
  attention: readonly [string, readonly SessionAttention[]][] = [],
): BoardAgent {
  return {
    agentId,
    name: agentId,
    owned: true,
    sessions,
    attention: new Map(attention),
    parents: new Map(sessions.map((session) => [session.sessionId, null])),
    waitingNotRead: 0,
  };
}

test("needs you lists only person-bound attention, oldest wait first", () => {
  const rows = readRows(
    [
      agent(
        "late",
        [row("s", "needs_you", { title: "docs pass" })],
        [["s", [item("approval", "Approve files.write", 9_000)]]],
      ),
      agent(
        "early",
        [row("s", "needs_you")],
        [["s", [item("question", "Which branch?", 1_000)]]],
      ),
      agent(
        "routed",
        [row("s", "running")],
        [["s", [item("question", "For the lead", 500, true)]]],
      ),
    ],
    now,
  );
  expect(
    rows.needs.map(({ agentName, kind, summary }) => [
      agentName,
      kind,
      summary,
    ]),
  ).toEqual([
    ["early", "question", "Which branch?"],
    ["late", "approval", "Approve files.write"],
  ]);
  expect(rows.needs[1]?.sessionTitle).toBe("docs pass");
});

test("an inbox-false question counts as waiting on an agent, never needs you", () => {
  const rows = readRows(
    [
      agent(
        "routed",
        [row("s", "running")],
        [["s", [item("question", "For the lead", 500, true)]]],
      ),
    ],
    now,
  );
  expect(rows.needs).toEqual([]);
  expect(rows.lanes.map(({ state }) => state)).toEqual(["waiting_on_agent"]);
});

test("only the exact parent's explicit escalation is escalatedByParent", () => {
  const parent = { agentId: "shiitake", sessionId: "lead", name: "Shiitake" };
  for (const [by, reason, expected] of [
    [parent, "escalated", true],
    [{ ...parent, sessionId: "sibling-session" }, "escalated", false],
    [parent, "sender_archived", false],
    [parent, "sender_absent", false],
  ] as const) {
    const child = {
      ...agent(
        "sol",
        [row("s", "needs_you")],
        [
          [
            "s",
            [
              {
                ...item("question", "Budget?", now - minute),
                escalated: { by, reason, note: "Decision" },
              },
            ],
          ],
        ],
      ),
      parents: new Map([["s", parent]]),
    };
    const view = project(readRows([child], now), [], collapsed);
    expect(view.needsYou[0]).toMatchObject({
      parent,
      escalated: { by, reason },
      escalatedByParent: expected,
    });
    const title = boardView(view, { now, width: 100 }).sections[0]?.rows[0]
      ?.title;
    expect(title).toContain(
      reason === "escalated"
        ? "escalated by Shiitake"
        : reason === "sender_archived"
          ? "Shiitake archived"
          : "Shiitake is gone",
    );
  }
});

test("a waiting lane names its recipient and never hides unread waiting Sessions", () => {
  const parent = { agentId: "shiitake", sessionId: "lead", name: "Shiitake" };
  const child = {
    ...agent(
      "sol",
      [row("s", "done")],
      [
        [
          "s",
          [
            {
              ...item("question", "Branch?", now - minute, true),
              waitingOn: parent,
            },
          ],
        ],
      ],
    ),
    parents: new Map([["s", parent]]),
    waitingNotRead: 2,
  };
  const view = project(readRows([child], now), [], {
    lanes: true,
    shipping: false,
  });
  expect(view.lanes.shown[0]).toMatchObject({
    state: "waiting_on_agent",
    waitingOn: parent,
    parent,
    waitingNotRead: 2,
  });
  expect(
    boardView(view, { now, width: 100 })
      .sections.flatMap((section) => section.rows)
      .find((item) => item.id === "lane/sol")?.title,
  ).toContain("waiting on Shiitake: Branch? · 2 more waiting");
});

test("goal-blocked and goal-stalled read stuck; goal-waiting reads working", () => {
  const rows = readRows(
    [
      agent(
        "blocked",
        [row("s", "done")],
        [["s", [item("goal-blocked", "staging key missing", 100, true)]]],
      ),
      agent(
        "stalled",
        [row("s", "done")],
        [["s", [item("goal-stalled", "no progress", 200, true)]]],
      ),
      agent(
        "waiting",
        [row("s", "done")],
        [["s", [item("goal-waiting", "waiting on CI", 300, true)]]],
      ),
    ],
    now,
  );
  expect(
    rows.lanes.map(({ agentId, state, detail }) => [agentId, state, detail]),
  ).toEqual([
    ["blocked", "stuck", "staging key missing"],
    ["stalled", "stuck", "no progress"],
    ["waiting", "working", undefined],
  ]);
});

test("an unreadable Agent is unavailable, never idle", () => {
  const rows = readRows(
    [
      agent("quiet", []),
      {
        ...agent("old", []),
        unreadable: "predates the current schema",
      },
    ],
    now,
  );
  expect(
    rows.lanes.map(({ agentId, state, detail }) => [agentId, state, detail]),
  ).toEqual([
    ["old", "unavailable", "predates the current schema"],
    ["quiet", "idle", undefined],
  ]);
});

test("a conversation stored as running in a store no runtime holds is stopped, not working", () => {
  const rows = readRows(
    [
      agent("live", [row("s", "running")]),
      { ...agent("left", [row("s", "running")]), owned: false },
    ],
    now,
  );
  expect(rows.lanes.map(({ agentId, state }) => [agentId, state])).toEqual([
    ["left", "stopped"],
    ["live", "working"],
  ]);
  const board = project(rows, [], collapsed);
  expect(board.lanes.shown.map(({ agentId }) => agentId)).toEqual(["left"]);
  expect(board.lanes.counts).toMatchObject({ working: 1, stopped: 1 });
});

test("working lanes collapse to a count and stuck ones are listed", () => {
  const rows = readRows(
    [
      agent("one", [row("s", "running")]),
      agent("two", [row("s", "running")]),
      agent("three", [row("s", "running")]),
      agent(
        "stuck",
        [row("s", "done")],
        [["s", [item("goal-blocked", "needs a key", 100, true)]]],
      ),
    ],
    now,
  );
  const board = project(rows, [], collapsed);
  expect(board.lanes.shown.map(({ agentId }) => agentId)).toEqual(["stuck"]);
  expect(board.lanes.counts).toMatchObject({ working: 3, stuck: 1 });
  expect(boardView(board, { width: 120, now }).summary).toBe("3 working");
  const every = project(rows, [], { lanes: true, shipping: false });
  expect(every.lanes.shown[0]?.agentId).toBe("stuck");
  expect(every.lanes.shown).toHaveLength(4);
});

test("an errored run reads failed only on the day it failed", () => {
  const today = readRows(
    [agent("a", [row("s", "errored", { at: now - minute })])],
    now,
  );
  const old = readRows(
    [agent("a", [row("s", "errored", { at: now - 30 * 60 * minute })])],
    now,
  );
  expect(today.lanes[0]?.state).toBe("failed");
  expect(old.lanes[0]?.state).toBe("idle");
});

test("a failed read says so, keeps the last good lists, and never looks calm", () => {
  const good = readRows(
    [
      agent(
        "stuck",
        [row("s", "done")],
        [["s", [item("goal-blocked", "needs a key", 100, true)]]],
      ),
    ],
    now,
  );
  const failed = failedRows(good, new Error("ENOTDIR: not a directory"), now);
  const board = project(failed, [], collapsed);
  expect(board.readFailure).toBe("ENOTDIR: not a directory");
  expect(board.lanes.shown.map(({ agentId }) => agentId)).toEqual(["stuck"]);
  const drawn = boardView(board, { width: 120, now });
  expect(drawn.calm).toBeNull();
  expect(drawn.failure).toBe(
    "Could not read the Agents: ENOTDIR: not a directory",
  );
});
