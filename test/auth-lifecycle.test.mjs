import { createWhistle } from "@fungi.computer/whistle";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { setImmediate } from "node:timers/promises";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

// Dispatch/cleanup coverage only; auth-native.proof.mjs owns physical rendering.
test("mounted account dispatch does not reconnect or close client resources", async () => {
  const events = [];
  let accountRun;
  let commands;
  const interaction = createWhistleInteractionHost({ title: "Sign in" }).begin()
    .interaction;
  const service = {
    discover: async () => ({ agents: [], sessions: [], problems: [] }),
    models: async () => [],
    connect: async () => {
      events.push("connect");
      return {
        sandboxStatus: async () => ({
          mode: "full-access",
          available: true,
        }),
        agentId: "agent-fixture",
        sessionId: "session-fixture",
        databasePath: "/tmp/fixture.sqlite",
        session: {
          address: "fixture:session",
          modelPreference: { read: async () => null },
        },
        close: async () => {
          events.push("client-close");
        },
      };
    },
    auth: async (request, supplied) => {
      assert.deepEqual(request, {
        command: "login",
        provider: "openai",
        authType: "api_key",
      });
      assert.equal(supplied.signal, interaction.signal);
      assert.deepEqual(events, ["connect"]);
      events.push("auth");
    },
  };
  await runTuiCli(
    { invocationRoot: "/tmp" },
    {
      createServiceManager: () => service,
      prepareClientExtensions: noOpClientExtensions,
      loadThemePreference: async () => ({ theme: "terminal" }),
      createWhistle: () => {
        commands = createWhistle();
        return commands;
      },
      renderConnecting: () => undefined,
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({
        destroy: () => {
          events.push("renderer-close");
        },
      }),
      createRoot: () => ({
        unmount: () => {
          events.push("root-close");
        },
      }),
      enableKeymap: false,
      render: (_root, _query, _session, _commands, exit) => {
        accountRun = setImmediate()
          .then(() =>
            commands.execute(
              { namespace: "account", id: "login" },
              {
                origin: "programmatic",
                interaction,
                arguments: { providerId: "openai", method: "api_key" },
              },
            ),
          )
          .finally(exit);
      },
    },
  );
  const outcome = await accountRun;
  assert.deepEqual(outcome, { status: "handled" });
  assert.ok(events.includes("auth"));
  assert.equal(events.filter((event) => event === "connect").length, 1);
  assert.ok(events.indexOf("auth") < events.indexOf("client-close"));
  assert.ok(events.indexOf("renderer-close") < events.indexOf("client-close"));
});
