import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "bun:test";
import { act } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";

import { runTuiCli } from "@fungi.computer/tui/cli-runtime";
import { createTuiFixture } from "./fixture.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

test("confirmed theme survives Session replacement in one terminal", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const commands = createWhistle();
  const ready = Promise.withResolvers();
  let setup;
  let running;
  let saved = "terminal";
  let generation = 0;
  const client = () => {
    const fixture = createTuiFixture();
    return {
      agentId: "agent-fixture",
      sessionId: `session-theme-${generation + 1}`,
      databasePath: "/fixture/agent.sqlite",
      session: {
        ...fixture.session,
        address: `fixture://theme-${++generation}`,
        modelPreference: {
          read: async () => null,
          set: async () => undefined,
        },
      },
      close: async () => undefined,
    };
  };
  const frame = () =>
    act(async () => {
      await delay(10);
      await setup.renderOnce();
    });
  try {
    await act(async () => {
      running = runTuiCli(
        {
          invocationRoot: "/fixture",
          databasePath: "/fixture/agent.sqlite",
        },
        {
          loadThemePreference: async () => ({ theme: saved }),
          saveThemePreference: async (theme) => {
            saved = theme;
          },
          prepareClientExtensions: noOpClientExtensions,
          createWhistle: () => commands,
          createServiceManager: () => ({
            models: async () => [],
            connect: async () => client(),
            createSession: async () => client(),
          }),
          createRenderer: async () => {
            setup = await createTestRenderer({
              width: 96,
              height: 28,
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
    await frame();
    await act(async () => {
      await setup.mockInput.typeText("/theme");
      setup.mockInput.pressEnter();
    });
    await frame();
    await act(async () => {
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressArrow("down");
    });
    await frame();
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await frame();
    assert.equal(saved, "latte");

    await act(async () => {
      await setup.mockInput.typeText("/new");
      setup.mockInput.pressEnter();
    });
    await frame();
    assert.equal(generation, 2);
    await act(async () => {
      await setup.mockInput.typeText("/theme");
      setup.mockInput.pressEnter();
    });
    await frame();
    // The reopened theme Picker starts on, and marks, the saved theme.
    assert.match(setup.captureCharFrame(), /▶ ● Latte/u);
  } finally {
    await act(async () => {
      await commands.execute("tui:exit", { origin: "slash" });
    });
    await running;
  }
});
