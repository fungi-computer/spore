import assert from "node:assert/strict";
import process from "node:process";
import { mkdir } from "node:fs/promises";
import { test } from "bun:test";
import { act } from "react";
import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";
import { runTuiCli } from "../src/cli-runtime.js";
import { createTuiFixture } from "./fixture.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { waitForFrame } from "./native-readiness.js";
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
    const commands = createWhistle();
    const ready = Promise.withResolvers();
    const opened = [];
    const closed = [];
    let setup;
    let running;
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
      return {
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
        close: async () => {
          closed.push(name);
        },
      };
    };
    const output = process.env.PANE_CAPTURE_DIR;
    if (output) await mkdir(output, { recursive: true });
    try {
      await act(async () => {
        running = runTuiCli(
          { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
          {
            loadThemePreference: async () => ({ theme: "terminal" }),
            prepareClientExtensions: noOpClientExtensions,
            createWhistle: () => commands,
            discoverSessions: async () => ({
              agentCount: 1,
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
      await waitForFrame(setup, (frame) =>
        frame.includes("original conversation"),
      );
      assert.equal(composers(setup).length, 1);
      const originalScope = conversationScopes(commands);
      assert.equal(originalScope.length, 1);
      assert.ok(originalScope[0]);
      await captureFrame(setup, output, `before-${command}-80x24`);
      await act(async () => {
        await setup.mockInput.typeText(`/${command}`);
        setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, (frame) =>
        frame.includes(
          command === "resume" ? "Saved conversation" : "Fork from message",
        ),
      );
      assert.deepEqual(opened, ["original"]);
      if (command === "resume") {
        await act(async () => setup.mockInput.pressEscape());
        await waitForFrame(
          setup,
          (frame) => !frame.includes("Saved conversation"),
        );
        assert.deepEqual(conversationScopes(commands), originalScope);
        assert.deepEqual(opened, ["original"]);
        assert.deepEqual(closed, []);
        await act(async () => {
          await setup.mockInput.typeText("/resume");
          setup.mockInput.pressEnter();
        });
        await waitForFrame(setup, (frame) =>
          frame.includes("Saved conversation"),
        );
      }
      await act(async () => setup.mockInput.pressEnter());
      await waitForFrame(setup, (frame) =>
        frame.includes(
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
      await act(async () => {
        await setup.mockInput.typeText("/new");
        setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, (frame) =>
        frame.includes("fresh conversation"),
      );
      assert.equal(composers(setup).length, 1);
      assert.deepEqual(closed, ["original", destination]);
      assert.deepEqual(conversationScopes(commands), originalScope);
      // Explicit Open pane -> Resume conversation is the sole additive
      // selection path for a saved conversation.
      const paneCommand = commands
        .snapshot()
        .palette.find((row) => row.title === "Open pane");
      assert.ok(paneCommand);
      await act(async () =>
        commands.execute(paneCommand.commandId, { origin: "keyboard" }),
      );
      await waitForFrame(setup, (frame) =>
        frame.includes("Resume conversation"),
      );
      // Local terminal, New conversation, then Resume conversation.
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await waitForFrame(setup, (frame) =>
        frame.includes("Saved conversation"),
      );
      await act(async () => setup.mockInput.pressEnter());
      await waitForFrame(setup, () => composers(setup).length === 2);
      const scopes = conversationScopes(commands);
      assert.equal(scopes.length, 2);
      assert.ok(scopes.includes(originalScope[0]));
      assert.deepEqual(closed, ["original", destination]);
    } finally {
      await act(async () => commands.execute("tui:exit", { origin: "slash" }));
      await running;
    }
  });
}
