import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "bun:test";
import { act } from "react";
import { TextareaRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle/service";
import subagentsClient from "@fungi.computer/shiitake-extensions/subagents/client";
import * as Effect from "effect/Effect";
import { runTuiCli } from "../src/cli-runtime.js";
import { executeAlias, waitForCommandGraph } from "./command-selection.js";
import { enterReactActEnvironment } from "./native-renderer-cleanup.js";

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

const nodes = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(nodes),
];
const composers = (setup: Setup) =>
  nodes(setup.renderer.root).filter(
    (node) => node instanceof TextareaRenderable,
  );

/** An Agent store as agents.create leaves it: named, and made by another Agent. */
function writeCreatedAgentStore(
  path: string,
  agentId: string,
  name: string,
  createdBy: string,
) {
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE private_local_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), agent_id TEXT NOT NULL UNIQUE, name TEXT, created_by TEXT, archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), folder TEXT NOT NULL DEFAULT '.', require_sandbox INTEGER NOT NULL DEFAULT 0 CHECK (require_sandbox IN (0, 1)))",
  );
  database
    .prepare(
      "INSERT INTO private_local_identity (singleton, agent_id, name, created_by) VALUES (1, ?, ?, ?)",
    )
    .run(agentId, name, createdBy);
  database.exec(
    "CREATE TABLE private_local_model_settings (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), model TEXT NOT NULL) STRICT",
  );
  database.exec("INSERT INTO private_local_model_settings VALUES (1, 'null')");
  database.close();
}

// Real stores, a real Local service and the real TUI root: only the terminal is a test renderer.
test("clicking a footer sub-agent row opens that Agent's conversation beside the parent and keeps it open", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-agent-row-")),
  );
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".fungi"), { recursive: true, mode: 0o700 });
  await mkdir(project);
  const savedHome = process.env.HOME;
  const savedBuild = process.env.FUNGI_BUNDLED_BUILD_ID;
  process.env.HOME = home;
  process.env.FUNGI_BUNDLED_BUILD_ID = "a".repeat(64);
  const manager = createPrivateLocalServiceManager({
    directory: join(home, ".fungi", "service"),
  });
  const commands = createWhistle();
  const ready = Promise.withResolvers<Setup>();
  let running: Promise<unknown> | undefined;
  const restoreActEnvironment = enterReactActEnvironment();
  try {
    const parent = await manager.connect({ invocationRoot: project });
    const childId = "local_store_scoutscoutscoutscout1";
    const childDirectory = join(project, ".fungi", "agents", childId);
    await mkdir(childDirectory, { recursive: true });
    const childPath = join(childDirectory, "agent.sqlite");
    writeCreatedAgentStore(childPath, childId, "Scout", parent.agentId);
    const child = await manager.createSession({
      invocationRoot: project,
      databasePath: childPath,
      requestId: "scout-first-conversation",
    });
    assert.equal(child.agentId, childId);
    const childSessionId = child.sessionId;
    await child.close();
    // The parent host's own record that this conversation sent the child work.
    const parentStore = new DatabaseSync(parent.databasePath);
    parentStore.exec(
      "CREATE TABLE IF NOT EXISTS oyster_conversation_agents (parent_session_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT, at INTEGER NOT NULL, PRIMARY KEY (parent_session_id, agent_id)) STRICT",
    );
    parentStore
      .prepare(
        "INSERT INTO oyster_conversation_agents (parent_session_id, agent_id, session_id, at) VALUES (?, ?, ?, ?)",
      )
      .run(parent.sessionId, childId, childSessionId, Date.now());
    parentStore.close();
    const parentDatabasePath = parent.databasePath;
    const parentSessionId = parent.sessionId;
    await parent.close();

    await act(async () => {
      running = runTuiCli(
        {
          invocationRoot: project,
          databasePath: parentDatabasePath,
          sessionId: parentSessionId,
          clients: [subagentsClient],
        },
        {
          loadThemePreference: () => Promise.resolve({ theme: "mocha" }),
          prepareClientExtensions: (options) =>
            Effect.succeed({
              entries: Effect.succeed([...(options.clients ?? [])]),
              attach: () => Effect.void,
            }),
          createWhistle: () => commands,
          createServiceManager: () => manager,
          createRenderer: async () => {
            const created = await createTestRenderer({
              width: 120,
              height: 40,
              useKittyKeyboard: null,
            });
            ready.resolve(created);
            return created.renderer;
          },
          enableKeymap: true,
        },
      );
      await ready.promise;
    });
    const setup = await ready.promise;
    const settle = async (milliseconds: number) =>
      act(async () => {
        await delay(milliseconds);
        await setup.renderOnce();
      });
    const rowLine = async (text: string) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await settle(100);
        const found = setup
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes(text));
        if (found >= 0) return found;
      }
      throw new Error(
        `The footer never listed the sub-agent:\n${setup.captureCharFrame()}`,
      );
    };
    await rowLine("1 sub-agent");
    expect(setup.captureCharFrame()).not.toContain("Scout · ");
    await waitForCommandGraph(commands, (snapshot) =>
      snapshot.slash.some((row) => row.alias === "agents"),
    );
    await act(async () =>
      executeAlias(commands, "agents", { origin: "slash" }),
    );
    const row = await rowLine("Scout · ");
    expect(composers(setup)).toHaveLength(1);
    await act(async () => {
      await setup.mockMouse.click(10, row);
    });
    const deadline = Date.now() + 30_000;
    while (composers(setup).length < 2 && Date.now() < deadline)
      await settle(100);
    expect(composers(setup)).toHaveLength(2);
    // The pane stays: nothing closes it a moment later.
    for (let pass = 0; pass < 20; pass += 1) await settle(100);
    expect(composers(setup)).toHaveLength(2);
    expect(setup.captureCharFrame()).toContain("Scout · ");
    // A clean run writes no failure log at all.
    const logPath = join(home, ".fungi", "logs", "tui.jsonl");
    expect(
      existsSync(logPath) ? await readFile(logPath, "utf8") : "",
    ).not.toContain("client-row-open");
  } finally {
    try {
      // The shell's own exit ends the run; a failure of the run fails the test.
      const closing = running;
      if (closing !== undefined) {
        await act(async () => {
          await commands.execute("tui:exit", { origin: "slash" });
          await closing;
        });
      }
      commands.close();
      await manager.stop();
    } finally {
      restoreActEnvironment();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedBuild === undefined) delete process.env.FUNGI_BUNDLED_BUILD_ID;
      else process.env.FUNGI_BUNDLED_BUILD_ID = savedBuild;
      await rm(root, { recursive: true, force: true });
    }
  }
}, 120_000);
