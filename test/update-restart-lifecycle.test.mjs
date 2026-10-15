import { test } from "bun:test";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { createWhistle } from "@fungi.computer/whistle";
import { runTuiCli } from "../src/cli-runtime.js";

test("an updated idle client closes the old terminal and Session before resuming that Session in the installed build", async () => {
  const events = [];
  let controls;
  let exit;
  let idle = false;
  const restart = {
    kind: "restart",
    launcher: "/installed/new-fungi",
    session: { invocationRoot: "/fixture", sessionId: "session-original" },
  };
  const app = runTuiCli(
    {
      invocationRoot: "/fixture",
      databasePath: "/fixture/agent.sqlite",
      sessionId: "session-original",
    },
    {
      clientBuildId: "a".repeat(64),
      checkInstalledUpdate: async (sessions) => {
        assert.deepEqual(sessions, [restart.session]);
        events.push(idle ? "idle" : "running");
        return idle ? restart : { kind: "waiting" };
      },
      resumeInstalledUpdate: async (update) => {
        assert.deepEqual(update, restart);
        events.push("new client resumed");
      },
      createServiceManager: () => ({
        connect: async () => ({
          agentId: "agent-fixture",
          sessionId: "session-original",
          databasePath: "/fixture/agent.sqlite",
          session: {
            address: "fixture://session-original",
            modelPreference: {
              read: async () => null,
              set: async () => undefined,
            },
          },
          close: async () => {
            events.push("old Session closed");
          },
        }),
        status: async () => ({
          serviceId: "updated-service",
          baseUrl: "http://127.0.0.1:1234",
          buildId: "b".repeat(64),
        }),
      }),
      createWhistle,
      loadThemePreference: async () => ({ theme: "terminal" }),
      prepareClientExtensions: () =>
        Effect.succeed({
          entries: Effect.succeed([]),
          attach: () => Effect.void,
        }),
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({
        destroy: () => events.push("old terminal closed"),
      }),
      createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      renderConnecting: () => undefined,
      renderRecovery: (_root, error) => {
        throw error;
      },
      renderServiceMismatch: () => events.push("manual upgrade prompt"),
      enableKeymap: false,
      render: (_root, _query, _session, _commands, onExit, _theme, next) => {
        controls = next;
        exit = onExit;
      },
    },
  );
  const timeout = setTimeout(() => exit?.(), 2_500);
  try {
    while (controls === undefined) await delay(1);
    await controls.onObservationUnavailable();
    assert.deepEqual(events, ["running"]);
    idle = true;
    await app;
    assert.ok(events.includes("new client resumed"));
    assert.ok(
      events.indexOf("old terminal closed") <
        events.indexOf("new client resumed"),
    );
    assert.ok(
      events.indexOf("old Session closed") <
        events.indexOf("new client resumed"),
    );
    assert.equal(events.includes("manual upgrade prompt"), false);
  } finally {
    clearTimeout(timeout);
    exit?.();
    await app;
  }
});
