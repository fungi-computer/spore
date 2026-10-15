import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { runningActivity } from "@fungi.computer/parakeet-testing";
import { runTuiCli } from "@fungi.computer/tui/cli-runtime";
import { createTuiFixture } from "./fixture.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

test("Escape visibly stops one disposable running turn exactly once", async () => {
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const fixture = createTuiFixture();
  const setup = await createTestRenderer({
    width: 96,
    height: 24,
    useKittyKeyboard: null,
  });
  const commands = createWhistle();
  const session = {
    ...fixture.session,
    modelPreference: {
      read: async () => null,
      set: async () => undefined,
    },
  };
  const ready = Promise.withResolvers();
  let running;
  try {
    await act(async () => {
      running = runTuiCli(
        { invocationRoot: "/fixture", sessionId: "tui-fixture" },
        {
          loadThemePreference: async () => ({ theme: "terminal" }),
          prepareClientExtensions: noOpClientExtensions,
          createServiceManager: () => ({
            connect: async () => ({
              agentId: "agent-fixture",
              databasePath: "/fixture/agent.sqlite",
              sessionId: "tui-fixture",
              session,
              close: async () => undefined,
            }),
            models: async () => [],
          }),
          createWhistle: () => commands,
          enableKeymap: true,
          createRenderer: async () => {
            ready.resolve();
            return setup.renderer;
          },
        },
      );
      await Promise.race([ready.promise, running]);
    });
    await act(async () => {
      await setup.waitForFrame((frame) =>
        frame.includes("Start a conversation."),
      );
      await fixture.session.command({
        type: "prompt",
        requestId: "running-test",
        delivery: "followUp",
        text: "Keep working until cancelled",
      });
      fixture.confirmLatestPrompt();
      await setup.waitForFrame((frame) =>
        frame.includes("Fixture is streaming a reply."),
      );
    });
    await act(async () => {
      setup.mockInput.pressEscape();
      await delay(25);
    });
    await act(async () => setup.renderOnce());
    assert.deepEqual(fixture.cancelCalls(), [
      { type: "cancel", commandId: "owner-running-test" },
    ]);
    assert.equal(fixture.abortCalls(), 0);
    const afterFirstPress = setup.captureCharFrame();
    await act(async () => {
      setup.mockInput.pressEscape();
      await delay(25);
    });
    await act(async () => setup.renderOnce());
    assert.deepEqual(fixture.cancelCalls(), [
      { type: "cancel", commandId: "owner-running-test" },
    ]);
    assert.equal(fixture.abortCalls(), 0);
    assert.match(afterFirstPress, /cancelling…/u);
    await act(async () => {
      fixture.pushFrame({
        kind: "update",
        delivery: "live",
        cursor: "fixture-follow-up",
        messages: [],
        terminals: [],
        pending: { total: 0, prompts: [], hasMore: false },
        extensions: {},
        attention: [],
        activity: runningActivity({
          queue: { state: "running", commandId: "follow-up-run" },
        }),
      });
      await delay(20);
    });
    await act(async () => setup.renderOnce());
    assert.doesNotMatch(setup.captureCharFrame(), /cancelling…/u);
    for (let press = 0; press < 2; press++) {
      await act(async () => {
        setup.mockInput.typeText("/cancel");
        setup.mockInput.pressEnter();
        await delay(10);
      });
      await act(async () => setup.renderOnce());
      assert.deepEqual(
        fixture.cancelCalls(),
        [
          { type: "cancel", commandId: "owner-running-test" },
          { type: "cancel", commandId: "follow-up-run" },
        ],
        "Enter must cancel the new run once",
      );
      assert.equal(fixture.abortCalls(), 0);
    }
  } finally {
    await act(async () => {
      await commands.execute("tui:exit", { origin: "slash" });
      await running;
    });
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    await fixture.waitForClose();
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
