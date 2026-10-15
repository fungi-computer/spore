import { executeAlias } from "./command-selection.js";
import process from "node:process";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "bun:test";
import { act } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { createWhistle } from "@fungi.computer/whistle";
import { runTuiCli } from "@fungi.computer/tui/cli-runtime";
import { createTuiFixture } from "./fixture.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { configuredModelAccess, modelHistory } from "./model-access-fixture.js";

test("slash model saves update one mounted frame without duplicate commands", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const fixture = createTuiFixture({
    messages: modelHistory("fixture", "model"),
  });
  const commands = createWhistle();
  const executions = [];
  const execute = commands.execute;
  const observedCommands = {
    ...commands,
    execute: async (commandId, options) => {
      const outcome = await execute(commandId, options);
      executions.push({ commandId, outcome });
      return outcome;
    },
  };
  const setup = await createTestRenderer({
    width: 72,
    height: 25,
    useKittyKeyboard: null,
  });
  const ready = Promise.withResolvers();
  let running;
  let preference = null;
  let renders = 0;
  let closes = 0;
  const models = [
    {
      id: "model",
      providerId: "fixture",
      name: "Fixture model",
      providerName: "Fixture",
      reasoning: ["low"],
    },
  ];
  try {
    await act(async () => {
      running = runTuiCli(
        { invocationRoot: "/tmp", databasePath: "/tmp/fixture.sqlite" },
        {
          loadThemePreference: async () => ({ theme: "terminal" }),
          createWhistle: () => observedCommands,
          enableKeymap: true,
          createRoot: (renderer) => {
            const root = createRoot(renderer);
            return {
              unmount: root.unmount,
              render: (node) => {
                renders++;
                root.render(node);
              },
            };
          },
          createRenderer: async () => {
            ready.resolve();
            return setup.renderer;
          },
          prepareClientExtensions: noOpClientExtensions,
          createServiceManager: () => ({
            models: async () => models,
            auth: async () => configuredModelAccess(models),
            connect: async () => ({
              agentId: "agent-fixture",
              sessionId: "session-fixture",
              databasePath: "/tmp/fixture.sqlite",
              effectiveModel: async () => ({
                agentName: "Shiitake",
                providerId: "fixture",
                providerName: "Fixture",
                modelId: "model",
                modelName: "Fixture model",
                credential: { kind: "api_key", source: "Fixture key" },
                label: `Shiitake · Fixture model${preference?.reasoning === undefined ? "" : ` · ${preference.reasoning}`} · Fixture key`,
              }),
              session: {
                ...fixture.session,
                modelPreference: {
                  read: async () => preference,
                  set: async (value) => {
                    preference = value;
                  },
                },
              },
              close: async () => {
                closes++;
              },
            }),
          }),
        },
      );
      await Promise.race([ready.promise, running]);
    });
    await act(async () => setup.renderOnce());
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => setup.mockInput.pressKey("u", { ctrl: true }));
      await act(async () => setup.mockInput.typeText("/model"));
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /SIGNED IN/u);
      assert.match(setup.captureCharFrame(), /DEFAULT/u);
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /Fixture · Fixture model/u);
      // Provider, model and thinking level all use Parakeet prompts.
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      assert.match(
        setup.captureCharFrame(),
        /Thinking level for Fixture model/u,
      );
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      assert.doesNotMatch(frame, /Canonical command ID|Error:/u);
      assert.match(frame, /fixture\/model/u);
      assert.doesNotMatch(
        frame,
        /Shiitake · Fixture model|Fixture model · low/u,
      );
      assert.deepEqual(preference, {
        providerId: "fixture",
        modelId: "model",
        reasoning: "low",
      });
      assert.equal(renders, 1);
      assert.equal(fixture.watchCalls(), 1);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const help = executeAlias(observedCommands, "help", {
        origin: "slash",
      });
      await act(async () => delay(10));
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /Commands/u);
      await act(async () => setup.mockInput.pressKey("c", { ctrl: true }));
      await act(async () => help);
      await act(async () => setup.renderOnce());
      assert.doesNotMatch(setup.captureCharFrame(), /Commands/u);
      assert.equal(setup.renderer.isDestroyed, false);
      assert.equal(renders, 1);
    }
    const ctrlC = observedCommands
      .snapshot()
      .bindings.find(
        (row) => row.binding === "ctrl+c" && row.scope !== undefined,
      );
    assert.ok(ctrlC, "focused pane has an admitted Ctrl+C action");
    executions.length = 0;
    await act(async () => setup.mockInput.pressKey("c", { ctrl: true }));
    await act(async () => setup.renderOnce());
    assert.deepEqual(executions, [
      { commandId: ctrlC.commandId, outcome: { status: "handled" } },
    ]);
    assert.equal(setup.renderer.isDestroyed, true);
  } finally {
    await act(async () => {
      if (!setup.renderer.isDestroyed) process.emit("SIGTERM");
    });
    await running;
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
  assert.equal(closes, 1);
  assert.equal(setup.renderer.isDestroyed, true);
});
