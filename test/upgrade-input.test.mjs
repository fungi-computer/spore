import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

test("Enter upgrades the shared service after a held turn and reopens the Session", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let setup;
  let running;
  let serviceStops = 0;
  let closes = 0;
  let connects = 0;
  let serviceBuildId = "b".repeat(64);
  const heldTurn = Promise.withResolvers();
  try {
    running = runTuiCli(
      { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
      {
        clientBuildId: "a".repeat(64),
        loadThemePreference: async () => ({ theme: "terminal" }),
        prepareClientExtensions: noOpClientExtensions,
        createServiceManager: () => ({
          stop: async () => {
            serviceStops++;
            await heldTurn.promise;
          },
          start: async () => {
            serviceBuildId = "a".repeat(64);
            return {
              serviceId: "new-service",
              baseUrl: "http://127.0.0.1:1235",
              buildId: serviceBuildId,
            };
          },
          connect: async () => {
            connects++;
            return {
              agentId: "agent-fixture",
              databasePath: "/fixture/agent.sqlite",
              sessionId: "saved-session",
              session: { address: "fixture://saved-session" },
              close: async () => {
                closes++;
              },
            };
          },
          status: async () => ({
            serviceId: "old-service",
            baseUrl: "http://127.0.0.1:1234",
            buildId: serviceBuildId,
          }),
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
        render: (
          _root,
          _query,
          _session,
          _commands,
          exit,
          _theme,
          controls,
        ) => {
          if (connects === 1) void controls.onObservationUnavailable();
          else exit();
        },
      },
    );
    for (let attempt = 0; attempt < 20 && setup === undefined; attempt++)
      await delay(5);
    assert.ok(setup);
    await act(async () => {
      await setup.renderOnce();
      await setup.waitForFrame(
        (frame) => frame.includes("Upgrade service") && frame.includes("Exit"),
      );
    });
    assert.doesNotMatch(setup.captureCharFrame(), /Restart this session/u);
    await act(async () => {
      setup.mockInput.pressEnter();
      await delay(20);
    });
    assert.equal(serviceStops, 1);
    assert.equal(connects, 1, "the other turn is still running");
    await act(async () => {
      heldTurn.resolve();
      await running;
    });
    assert.equal(
      setup.renderer.isDestroyed,
      true,
      "the reopened client exited normally",
    );
    assert.equal(connects, 2);
    assert.equal(closes, 2);
  } finally {
    heldTurn.resolve();
    if (setup !== undefined && !setup.renderer.isDestroyed)
      setup.renderer.destroy();
    if (running !== undefined) await running;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
