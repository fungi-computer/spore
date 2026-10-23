import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { URL, pathToFileURL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import process from "node:process";
import {
  createDesignTuiFixture,
  groupedToolsDesignSnapshot,
} from "./design-fixture.ts";

assert.equal(process.stdout.isTTY, true);
const installed = process.argv[2];
const entry =
  installed === undefined
    ? new URL("../src/cli.tsx", import.meta.url)
    : pathToFileURL(join(dirname(await realpath(installed)), "cli.js"));
const { runFungiCli } = await import(entry.href);
const payload =
  "\u001b]0;SANITIZER_TITLE\u0007\u001b]52;c;U0FOSVRJWkVSX0NMSVBCT0FSRA==\u0007\u001b]8;;https://sanitizer-invalid.test/spoof\u001b\\\u001b]8;;\u001b\\\u001b[2J\u001b[H\u009b2J\u202e";
const user = groupedToolsDesignSnapshot.messages.find(
  (message) => message.value.role === "user",
);
const assistant = groupedToolsDesignSnapshot.messages.find(
  (message) => message.value.role === "assistant",
);
assert.ok(user && assistant);
const fixture = createDesignTuiFixture({
  snapshot: {
    ...groupedToolsDesignSnapshot,
    messages: [
      {
        ...user,
        value: { ...user.value, content: `USER_SAFE ${payload} END_USER` },
      },
      {
        ...assistant,
        value: {
          ...assistant.value,
          content: [
            {
              type: "text",
              text: `PROSE_SAFE ${payload} END_PROSE\n\n\`\`\`text\nCODE_SAFE ${payload} END_CODE\n\`\`\``,
            },
          ],
        },
      },
    ],
    toolOutput: [],
    progress: null,
  },
});
const signals = new EventEmitter();
const databasePath = join(process.env.HOME, "fixture.sqlite");
let discoveries = 0;
let deadline;
try {
  await runFungiCli(
    ["resume", "--db", join(process.env.HOME, "fixture.sqlite")],
    { cwd: process.env.HOME },
    {
      signals,
      loadThemePreference: async () => ({ theme: "mocha" }),
      createServiceManager: () => {
        const manager = {
          // Match Local's discovery projection: saved identities resume through
          // this manager's connect door, rather than opening another Session.
          discover: async (invocationRoot, request) => {
            request?.signal?.throwIfAborted();
            discoveries += 1;
            return {
              agents: [
                {
                  agentId: "agent-fixture",
                  databasePath,
                  sessionCount: 1,
                },
              ],
              sessions: [
                {
                  databasePath,
                  sessionId: "session-fixture",
                  title: "Terminal sanitizer fixture",
                  createdAt: 1,
                  updatedAt: 1,
                  resume: (options) =>
                    manager.connect(
                      {
                        invocationRoot,
                        databasePath,
                        sessionId: "session-fixture",
                        fungiMcp: options?.fungiMcp,
                      },
                      options,
                    ),
                },
              ],
              problems: [],
            };
          },
          connect: async () => {
            deadline = setTimeout(() => signals.emit("SIGTERM"), 1_500);
            return {
              agentId: "agent-fixture",
              sessionId: "session-fixture",
              session: {
                ...fixture.session,
                modelPreference: {
                  read: async () => null,
                  set: async () => undefined,
                },
              },
              effectiveModel: async () => ({
                agentName: "Shiitake",
                providerId: "fixture",
                providerName: "Fixture",
                modelId: "fixture",
                modelName: "Fixture",
                credential: { kind: "api_key", source: "Fixture key" },
                label: "Shiitake · Fixture · Fixture key",
              }),
              sandboxStatus: async () => ({
                state: "available",
                requireSandbox: false,
              }),
              databasePath,
              close: () => Promise.resolve(),
            };
          },
          models: async () => [],
        };
        return manager;
      },
    },
  );
} finally {
  clearTimeout(deadline);
}
assert.ok(
  discoveries > 0,
  "resume discovered the saved fixture Session through the current manager contract",
);
assert.ok(
  fixture.watchCalls() > 0,
  "the real conversation observed its fixture Session",
);
process.stdout.write("SANITIZER_PTY_COMPLETE\n");
