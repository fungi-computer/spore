import { test } from "bun:test";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { createWhistle } from "@fungi.computer/whistle";
import { runTuiCli } from "../src/cli-runtime.js";
import { liveServiceStatusSchema } from "../../../runtimes/local/src/private-local-service-discovery.js";
import { localServiceIds } from "../../../runtimes/local/src/private-local-service-ids.js";

test("an updated idle client closes the old terminal and Session before resuming that Session in the installed build", async () => {
  const events = [];
  let controls;
  let exit;
  let idle = false;
  let statusChecks = 0;
  // Validate before starting the client: a stale fixture must fail the test,
  // not be caught as an unavailable service inside the reconnect boundary.
  const serviceStatus = liveServiceStatusSchema.parse({
    serviceId: localServiceIds.service.generate(),
    baseUrl: "http://127.0.0.1:1234",
    protocol: 5,
    version: "b".repeat(64),
    pid: 1,
    startedAt: "fixture-process-start",
    diagnostics: { state: "active" },
  });
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
      automaticInstalledRestart: true,
      checkpointDrafts: (_root, addresses) => {
        assert.deepEqual(addresses, ["fixture://session-original"]);
        events.push("draft checkpoint");
      },
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
          sandboxStatus: async () => ({
            mode: "full-access",
            available: true,
          }),
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
        status: async () => {
          statusChecks += 1;
          return serviceStatus;
        },
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
      renderServiceUpdated: () => events.push("restart message"),
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
    assert.equal(await controls.onObservationUnavailable(), false);
    assert.deepEqual(events, ["running"]);
    assert.equal(statusChecks, 1);
    idle = true;
    await app;
    assert.ok(events.includes("new client resumed"));
    assert.ok(
      events.indexOf("draft checkpoint") <
        events.indexOf("old terminal closed"),
    );
    assert.ok(
      events.indexOf("old terminal closed") <
        events.indexOf("new client resumed"),
    );
    assert.ok(
      events.indexOf("old Session closed") <
        events.indexOf("new client resumed"),
    );
    assert.equal(events.includes("restart message"), false);
  } finally {
    clearTimeout(timeout);
    exit?.();
    await app;
  }
});
