import { executeAlias } from "./command-selection.js";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { createWhistle } from "@fungi.computer/whistle";
import { contributeTerminalCommands } from "../src/panes/conversation/terminal-commands.js";

test("/reconnect reports connected, recovered, and failed outcomes", async () => {
  const commands = createWhistle();
  const notices = [];
  const outcomes = [
    { kind: "nothing_to_reconnect", state: "connected" },
    { kind: "reconnected" },
    { kind: "failed", cause: "socket reset" },
  ];
  const lease = contributeTerminalCommands(commands, {
    canCancel: false,
    canRetry: true,
    canContinue: true,
    cancel: async () => undefined,
    reconnect: async () => outcomes.shift(),
    details: () => undefined,
    toolGroup: () => undefined,
  });
  const interaction = {
    signal: new globalThis.AbortController().signal,
    prompt: () => Promise.reject(new Error("No prompt expected")),
    notify: (notice) => notices.push(notice),
  };
  try {
    for (let index = 0; index < 3; index += 1) {
      const result = await executeAlias(commands, "reconnect", {
        origin: "slash",
        interaction,
      });
      assert.equal(result.status, "handled");
    }
    assert.deepEqual(
      notices.map((notice) => notice.message),
      [
        "Session history is already connected.",
        "Session history reconnected.",
        "Reconnect failed: socket reset. Check the connection, then try /reconnect again.",
      ],
    );
  } finally {
    lease.dispose();
  }
});
