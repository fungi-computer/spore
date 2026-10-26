import assert from "node:assert/strict";
import { test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { LocalServiceUpdated } from "@fungi.computer/truffle/service";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

test("a running window whose service now speaks another protocol shows exactly one restart message, and Enter exits", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let setup;
  let running;
  let connects = 0;
  const recoveries = [];
  // Settles once the window has handled the lost observation, which is when
  // it shows the restart message: readiness, not a deadline.
  const handled = Promise.withResolvers();
  try {
    // The window runs inside act, so React flushes everything it renders.
    await act(async () => {
      running = runTuiCli(
        { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
        {
          loadThemePreference: async () => ({ theme: "terminal" }),
          prepareClientExtensions: noOpClientExtensions,
          createServiceManager: () => ({
            connect: async () => {
              connects++;
              return {
                sandboxStatus: async () => ({
                  mode: "full-access",
                  available: true,
                }),
                agentId: "agent-fixture",
                databasePath: "/fixture/agent.sqlite",
                sessionId: "saved-session",
                session: { address: "fixture://saved-session" },
                close: async () => undefined,
              };
            },
            // A newer client replaced the service this window reached.
            status: async () => {
              throw new LocalServiceUpdated();
            },
          }),
          createRenderer: async (options) => {
            setup = await createTestRenderer({
              ...options,
              width: 80,
              height: 24,
              useKittyKeyboard: null,
            });
            return setup.renderer;
          },
          renderRecovery: (_root, error) => {
            recoveries.push(error.message);
          },
          render: (
            _root,
            _query,
            _session,
            _commands,
            _exit,
            _theme,
            controls,
          ) => {
            controls
              .onObservationUnavailable()
              .then(handled.resolve, handled.reject);
          },
        },
      );
      // If the window ends first, that settles the race without a timer.
      assert.equal(
        await Promise.race([handled.promise, running.then(() => "ended")]),
        true,
      );
    });
    await act(async () => {
      assert.ok(setup);
      await setup.renderOnce();
      await setup.waitForFrame((frame) =>
        frame.includes("The Fungi service was updated. Restart this window."),
      );
    });
    const frame = setup.captureCharFrame();
    assert.equal(
      frame.split("The Fungi service was updated. Restart this window.").length,
      2,
    );
    assert.doesNotMatch(frame, /decode|schema|invalid|Zod|Upgrade/iu);
    assert.deepEqual(recoveries, []);
    await act(async () => {
      setup.mockInput.pressEnter();
      await running;
    });
    assert.equal(setup.renderer.isDestroyed, true);
    assert.equal(connects, 1);
  } finally {
    if (setup !== undefined && !setup.renderer.isDestroyed)
      setup.renderer.destroy();
    if (running !== undefined) await running;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
