import assert from "node:assert/strict";
import process from "node:process";
import { mkdir } from "node:fs/promises";
import { test } from "bun:test";
import { act } from "react";
import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";
import { createQueryClient } from "@fungi.computer/agar/query";
import { sessionQueryOptions } from "@fungi.computer/parakeet/headless";
import { notifyManager, QueryObserver } from "@tanstack/react-query";
import { runTuiCli } from "../src/cli-runtime.js";
import { createTuiFixture } from "./fixture.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";
import {
  observeCommandExecutions,
  waitForCommandGraph,
} from "./command-selection.js";
import { captureFrame } from "./frame-capture.js";

const nodes = (node) => [node, ...node.getChildren().flatMap(nodes)];
const composers = (setup) =>
  nodes(setup.renderer.root).filter(
    (node) => node instanceof TextareaRenderable,
  );

// The public scope appends an observation generation to the stable pane ID.
const conversationScopes = (commands) =>
  commands
    .snapshot()
    .slash.filter((row) => row.alias === "new")
    .map((row) => row.scope?.split(":")[0]);

// Real runTuiCli owns selection, the native pickers, the shell and pane observations.
for (const command of ["resume", "fork"]) {
  test(`/${command} replaces the current conversation instead of opening a pane`, async () => {
    const destination = command === "resume" ? "resumed" : "tui-fixture-fork";
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { commands, nextExecution } =
      observeCommandExecutions(createWhistle());
    const query = createQueryClient();
    const sessions = new Map();
    const ready = Promise.withResolvers();
    const opened = [];
    const closed = [];
    let setup;
    let running;
    const picker = async (text, open) => {
      await open();
      // Finish each React/layout delivery before testing the rendered result;
      // awaiting that result inside the same act would block its own commit.
      const frame = await waitForFrame(setup, (value) => value.includes(text));
      assert.ok(
        frame.includes(text),
        `Expected selection prompt: ${text}\n${frame}`,
      );
    };
    const enter = () =>
      pressDecodedKey(setup, () => setup.mockInput.pressEnter());
    const observed = async (name) => {
      const session = sessions.get(name);
      assert.ok(session, `Session ${name} was not acquired`);
      const observer = new QueryObserver(query, {
        ...sessionQueryOptions(session),
        enabled: false,
      });
      const live = Promise.withResolvers();
      const report = (result) => {
        if (result.data?.observation === "live") live.resolve();
      };
      const unsubscribe = observer.subscribe(report);
      report(observer.getCurrentResult());
      try {
        await live.promise;
        // Query completion precedes React Query's subscriber notifications.
        await new Promise((resolve) => notifyManager.schedule(resolve));
      } finally {
        unsubscribe();
      }
    };
    const mount = (name) => {
      const fixture = createTuiFixture({
        messages: [
          {
            id: `message-${name}`,
            commandId: null,
            sequence: 1,
            value: {
              role: "user",
              content: `${name === "tui-fixture-fork" ? "forked" : name} conversation`,
              timestamp: 1,
            },
          },
        ],
      });
      opened.push(name);
      const host = {
        agentId: "agent-fixture",
        sessionId: name,
        databasePath: "/fixture/agent.sqlite",
        session: {
          ...fixture.session,
          address: `fixture://${name}`,
          modelPreference: {
            read: async () => null,
            set: async () => undefined,
          },
        },
        effectiveModel: async () => ({
          agentName: "Shiitake",
          providerId: "fixture",
          providerName: "Fixture",
          modelId: "model",
          modelName: "Fixture model",
          credential: { kind: "api_key", source: "Fixture key" },
          label: "Shiitake · Fixture model · Fixture key",
        }),
        sandboxStatus: async () => ({
          mode: "full-access",
          available: true,
        }),
        close: async () => {
          closed.push(name);
        },
      };
      sessions.set(name, host.session);
      return host;
    };
    const output = process.env.PANE_CAPTURE_DIR;
    if (output) await mkdir(output, { recursive: true });
    try {
      await act(async () => {
        running = runTuiCli(
          { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
          {
            loadThemePreference: async () => ({ theme: "terminal" }),
            createQueryClient: () => query,
            prepareClientExtensions: noOpClientExtensions,
            createWhistle: () => commands,
            discoverSessions: async () => ({
              agents: [
                {
                  agentId: "one",
                  databasePath: "/project/one/agent.sqlite",
                  sessionCount: 1,
                },
              ],
              problems: [],
              sessions: [
                {
                  sessionId: "resumed",
                  title: "Saved conversation",
                  createdAt: 1,
                  updatedAt: 2,
                  resume: async () => mount("resumed"),
                },
              ],
            }),
            createServiceManager: () => ({
              models: async () => [],
              connect: async (input) => mount(input.sessionId ?? "original"),
              createSession: async () => mount("fresh"),
            }),
            createRenderer: async () => {
              setup = await createTestRenderer({
                width: 80,
                height: 24,
                useKittyKeyboard: null,
              });
              ready.resolve();
              return setup.renderer;
            },
            enableKeymap: true,
          },
        );
        await ready.promise;
      });
      await act(async () =>
        waitForCommandGraph(commands, (snapshot) =>
          snapshot.slash.some((row) => row.alias === "new"),
        ),
      );
      await act(async () => observed("original"));
      await act(async () => setup.renderOnce());
      assert.ok(setup.captureCharFrame().includes("original conversation"));
      assert.equal(composers(setup).length, 1);
      const originalScope = conversationScopes(commands);
      assert.equal(originalScope.length, 1);
      assert.ok(originalScope[0]);
      await captureFrame(setup, output, `before-${command}-80x24`);
      let selecting = nextExecution(command);
      await act(async () => {
        await setup.mockInput.typeText(`/${command}`);
      });
      await picker(
        command === "resume"
          ? "Saved conversation"
          : "Fork from which message?",
        enter,
      );
      assert.deepEqual(opened, ["original"]);
      if (command === "resume") {
        await pressDecodedKey(setup, () => setup.mockInput.pressEscape());
        await act(async () => selecting);
        await act(async () => setup.renderOnce());
        assert.ok(!setup.captureCharFrame().includes("Saved conversation"));
        assert.deepEqual(conversationScopes(commands), originalScope);
        assert.deepEqual(opened, ["original"]);
        assert.deepEqual(closed, []);
        selecting = nextExecution("resume");
        await act(async () => {
          await setup.mockInput.typeText("/resume");
        });
        await picker("Saved conversation", enter);
      }
      await enter();
      await act(async () => selecting);
      await act(async () => observed(destination));
      await act(async () => setup.renderOnce());
      assert.ok(
        setup
          .captureCharFrame()
          .includes(
            `${command === "fork" ? "forked" : destination} conversation`,
          ),
      );
      await captureFrame(setup, output, `after-${command}-80x24`);
      assert.equal(
        composers(setup).length,
        1,
        "Session switch must retain one pane/composer",
      );
      assert.deepEqual(
        conversationScopes(commands),
        originalScope,
        "The pane command scope must retain its identity",
      );
      assert.ok(!setup.captureCharFrame().includes("original conversation"));
      assert.deepEqual(
        closed,
        ["original"],
        "Only the old observation is retired",
      );
      // The already-landed /new behavior must remain in-place through this real root.
      const creating = nextExecution("new");
      await act(async () => {
        await setup.mockInput.typeText("/new");
      });
      await enter();
      await act(async () => creating);
      await act(async () => observed("fresh"));
      await act(async () => setup.renderOnce());
      assert.ok(setup.captureCharFrame().includes("fresh conversation"));
      assert.equal(composers(setup).length, 1);
      assert.deepEqual(closed, ["original", destination]);
      assert.deepEqual(conversationScopes(commands), originalScope);
      // Explicit Open pane -> Resume conversation is the sole additive
      // selection path for a saved conversation.
      const paneCommand = commands
        .snapshot()
        .palette.find((row) => row.title === "Open pane");
      assert.ok(paneCommand);
      await picker("Resume conversation", async () => {
        await act(async () => {
          const result = await commands.execute(paneCommand.command, {
            origin: "keyboard",
          });
          assert.equal(result.status, "handled", JSON.stringify(result));
        });
      });
      // New conversation is preselected, then Resume conversation.
      await pressDecodedKey(setup, () => setup.mockInput.pressArrow("down"));
      await picker("Saved conversation", enter);
      await enter();
      await act(async () =>
        waitForCommandGraph(
          commands,
          (snapshot) =>
            snapshot.slash.filter((row) => row.alias === "new").length === 2,
        ),
      );
      await act(async () => setup.renderOnce());
      assert.equal(composers(setup).length, 2);
      await act(async () => observed("resumed"));
      const scopes = conversationScopes(commands);
      assert.equal(scopes.length, 2);
      assert.ok(scopes.includes(originalScope[0]));
      assert.deepEqual(closed, ["original", destination]);
    } finally {
      await act(async () =>
        commands.execute({ namespace: "tui", id: "exit" }, { origin: "slash" }),
      );
      await act(async () => {
        await running;
        query.clear();
      });
    }
  });
}
