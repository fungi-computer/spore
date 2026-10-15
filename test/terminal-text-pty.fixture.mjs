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
    progress: null,
  },
});
const signals = new EventEmitter();
let deadline;
try {
  await runFungiCli(
    ["resume", "--db", join(process.env.HOME, "fixture.sqlite")],
    { cwd: process.env.HOME },
    {
      signals,
      clientBuildId: undefined,
      loadThemePreference: async () => ({ theme: "mocha" }),
      createServiceManager: () => ({
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
              providerId: "fixture",
              modelId: "fixture",
            }),
            databasePath: join(process.env.HOME, "fixture.sqlite"),
            close: () => Promise.resolve(),
          };
        },
        models: async () => [],
      }),
    },
  );
} finally {
  clearTimeout(deadline);
}
assert.ok(
  fixture.watchCalls() > 0,
  "the real conversation observed its fixture Session",
);
process.stdout.write("SANITIZER_PTY_COMPLETE\n");
