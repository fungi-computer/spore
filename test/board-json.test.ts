import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardAgent } from "@fungi.computer/truffle/board-agents";
import type { SessionAttention } from "@fungi.computer/shiitake/client";
import { boardJsonSchema, renderBoardJson } from "../src/board/json.js";
import { project, readRows } from "../src/board/model.js";
import { readBoardRows } from "../src/board/controller.js";
import { createIsolatedCliEnvironment } from "./cli-test-isolation.js";

test("JSON has the Board's rows, order and counts without the 16-row display cut", () => {
  const parent = { agentId: "shiitake", sessionId: "lead", name: "Shiitake" };
  const agents = Array.from({ length: 20 }, (_, index): BoardAgent => {
    const question: SessionAttention = {
      extensionId: "question",
      id: "q",
      kind: "question",
      summary: "Budget?",
      since: 100 + index,
    };
    if (index === 0)
      Object.assign(question, {
        escalated: { by: parent, reason: "escalated", note: "Budget decision" },
      });
    return {
      agentId: `sol-${String(index)}`,
      name: `Sol ${String(index)}`,
      owned: false,
      waitingNotRead: 0,
      sessions: [
        {
          sessionId: "s",
          state: "needs_you",
          title: "Build",
          createdAt: 1,
          lastActivityAt: 100,
        },
      ],
      parents: new Map([["s", parent]]),
      attention: new Map([["s", [question]]]),
    };
  }).reverse();
  const rows = readRows(agents, 500);
  const interactive = project(rows, [], { lanes: true, shipping: false });
  const text = renderBoardJson(rows, "/project");
  const view = boardJsonSchema.parse(JSON.parse(text));
  expect(text).toBe(renderBoardJson(rows, "/project"));
  expect(text).not.toContain("\u001b");
  expect(view.schemaVersion).toBe(1);
  expect(view.needsYou).toHaveLength(20);
  expect(view.lanes).toHaveLength(20);
  expect(view.counts).toEqual(interactive.lanes.counts);
  expect(interactive.needsYou).toHaveLength(16);
  expect(interactive.needsYouMore).toBe(4);
  expect(view.needsYou.map((item) => item.id)).toEqual(
    rows.needs.map((item) => item.id),
  );
  expect(view.needsYou.slice(0, 16).map((item) => item.id)).toEqual(
    interactive.needsYou.map((item) => item.id),
  );
  expect(view.needsYou[0]).toMatchObject({
    parent,
    ageMs: 400,
    escalatedByParent: true,
    escalated: { by: parent, note: "Budget decision" },
  });
  expect(view.needsYou[1]?.escalated).toBeNull();
  expect(view.needsYou[1]?.expiresAt).toBeNull();
  expect(view.lanes[0]?.waitingOn).toBeNull();
  expect(view.lanes[0]?.detail).toBe("Budget?");
  expect(view.readFailure).toBeNull();
  for (const item of view.needsYou)
    expect(item.ageMs).toBe(view.readAt - item.since);
  for (const item of view.lanes)
    expect(item.ageMs).toBe(
      item.since === null ? null : view.readAt - item.since,
    );
  expect(() => boardJsonSchema.parse({ ...view, extra: true })).toThrow();
});

test("the shared store read reports a real failure instead of a calm zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-board-fault-"));
  try {
    await mkdir(join(root, ".fungi"));
    await writeFile(join(root, ".fungi/agents"), "not a directory");
    const rows = await readBoardRows(root, 500);
    const view = boardJsonSchema.parse(JSON.parse(renderBoardJson(rows, root)));
    expect(view.readFailure).not.toBeNull();
    expect(view.needsYou).toEqual([]);
    expect(view.lanes).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fungi board --json -C an empty folder needs no terminal", async () => {
  const { runFungiCli } = await import("../src/cli.js");
  const root = await mkdtemp(join(tmpdir(), "fungi-cli-board-json-"));
  const chunks: string[] = [];
  try {
    await runFungiCli(["board", "--json", "-C", root], {
      interactive: false,
      stdout: {
        write: (text) => {
          chunks.push(String(text));
          return true;
        },
      },
    });
    expect(chunks).toHaveLength(1);
    const view = boardJsonSchema.parse(JSON.parse(chunks.join("")));
    expect(view).toMatchObject({
      schemaVersion: 1,
      root,
      readFailure: null,
      needsYou: [],
      lanes: [],
    });
    expect(chunks.join("").trim().split("\n")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fungi board --json rejects positionals and other flags", async () => {
  const { runFungiCli } = await import("../src/cli.js");
  for (const args of [
    ["board", "--json", "extra"],
    ["board", "--json", "--last"],
  ])
    await rejects(runFungiCli(args, { interactive: false }), Error);
});

test("fungi board --json writes the failure document before rejecting", async () => {
  const { runFungiCli } = await import("../src/cli.js");
  const root = await mkdtemp(join(tmpdir(), "fungi-cli-board-failure-"));
  const chunks: string[] = [];
  try {
    await mkdir(join(root, ".fungi"));
    await writeFile(join(root, ".fungi/agents"), "not a directory");
    await rejects(
      runFungiCli(["board", "--json", "-C", root], {
        interactive: false,
        stdout: {
          write: (text) => {
            chunks.push(String(text));
            return true;
          },
        },
      }),
      Error,
    );
    expect(chunks).toHaveLength(1);
    expect(
      boardJsonSchema.parse(JSON.parse(chunks.join(""))).readFailure,
    ).not.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the fungi executable exits 1 after writing a failed board --json document", async () => {
  const isolated = await createIsolatedCliEnvironment();
  const root = await mkdtemp(join(tmpdir(), "fungi-cli-board-exit-"));
  try {
    await mkdir(join(root, ".fungi"));
    await writeFile(join(root, ".fungi/agents"), "not a directory");
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/cli.tsx", import.meta.url).pathname,
        "board",
        "--json",
        "-C",
        root,
      ],
      {
        cwd: root,
        env: isolated.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(1);
    // A script still gets one parseable document naming the failure.
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(
      boardJsonSchema.parse(JSON.parse(stdout)).readFailure,
    ).not.toBeNull();
    expect(stderr).toStartWith("fungi: ");
    expect(stderr).not.toMatch(/\n\s+at /u);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      isolated.cleanup(),
    ]);
  }
}, 20_000);
