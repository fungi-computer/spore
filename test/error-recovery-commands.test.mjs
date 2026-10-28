import assert from "node:assert/strict";
import { test } from "bun:test";
import { createWhistle } from "@fungi.computer/whistle";
import {
  contributeTerminalCommands,
  terminalCommandDefinitions,
} from "../src/panes/conversation/terminal-commands.js";

test("failed-run choices retry or deliberately continue and report the result", async () => {
  const commands = createWhistle();
  const notices = [];
  const calls = [];
  const lease = contributeTerminalCommands(commands, {
    canCancel: false,
    canRetry: true,
    canContinue: true,
    cancel: async () => undefined,
    reconnect: async () => ({
      kind: "nothing_to_reconnect",
      state: "connected",
    }),
    retry: () => {
      calls.push("retry");
      return true;
    },
    continue: async () => {
      calls.push("continue");
      return true;
    },
    details: () => undefined,
    toolGroup: () => undefined,
  });
  const interaction = {
    signal: new globalThis.AbortController().signal,
    prompt: () => Promise.reject(new Error("No prompt expected")),
    notify: (notice) => notices.push(notice.message),
  };
  try {
    for (const command of [
      { namespace: "tui", id: "retry" },
      { namespace: "tui", id: "continue" },
    ]) {
      const outcome = await commands.execute(command, {
        origin: "slash",
        interaction,
      });
      assert.equal(outcome.status, "handled");
    }
    assert.deepEqual(calls, ["retry", "continue"]);
    // Starting what the person asked for is not announced.
    assert.deepEqual(notices, []);
  } finally {
    lease.dispose();
  }
});

test("inactive terminal controls are unavailable and failure recovery leads slash completion", async () => {
  const commands = createWhistle();
  const calls = [];
  const actions = {
    canCancel: false,
    canRetry: false,
    canContinue: false,
    cancel: async () => {
      calls.push("cancel");
    },
    reconnect: async () => ({
      kind: "nothing_to_reconnect",
      state: "connected",
    }),
    retry: () => true,
    continue: async () => true,
    details: () => undefined,
    toolGroup: () => undefined,
  };
  const lease = contributeTerminalCommands(commands, actions);
  try {
    const idle = commands.snapshot().slash;
    for (const alias of ["cancel", "retry", "continue"]) {
      assert.equal(
        idle.find((row) => row.alias === alias)?.availability.status,
        "unavailable",
      );
    }
    assert.equal(
      (
        await commands.execute(
          { namespace: "tui", id: "cancel" },
          { origin: "slash" },
        )
      ).status,
      "unavailable",
    );
    assert.deepEqual(calls, []);
    lease.update(
      terminalCommandDefinitions({
        ...actions,
        canRetry: true,
        canContinue: true,
      }),
    );
    const recovery = commands
      .snapshot()
      .slash.filter(
        (row) =>
          row.availability.status === "available" &&
          row.category === "Conversation",
      );
    assert.deepEqual(
      recovery.map((row) => row.alias),
      ["retry", "continue"],
    );
    lease.update(terminalCommandDefinitions({ ...actions, canCancel: true }));
    assert.equal(
      commands.snapshot().slash.find((row) => row.alias === "cancel")
        ?.availability.status,
      "available",
    );
  } finally {
    lease.dispose();
  }
});

test("Esc collapses the service status without cancelling work; Ctrl+B reopens it without colliding", async () => {
  const commands = createWhistle();
  const calls = [];
  const actions = {
    canCancel: false,
    canRetry: false,
    canContinue: false,
    serviceStatusOpen: true,
    cancel: async () => {
      calls.push("cancel");
    },
    reconnect: async () => ({ kind: "reconnected" }),
    retry: () => false,
    continue: async () => false,
    details: () => undefined,
    toolGroup: () => undefined,
    collapseServiceStatus: () => {
      calls.push("collapse");
      return true;
    },
    showServiceStatus: () => {
      calls.push("expand");
    },
  };
  const definitions = terminalCommandDefinitions(actions);
  const bound = definitions.flatMap((command) =>
    (command.projections?.bindings?.values ?? []).map((key) => [
      key,
      command.id,
    ]),
  );
  assert.deepEqual(
    bound.filter(([key]) => key === "ctrl+b"),
    [["ctrl+b", "service-status"]],
  );
  assert.equal(new Set(bound.map(([key]) => key)).size, bound.length);
  const lease = contributeTerminalCommands(commands, actions);
  try {
    assert.equal(
      (
        await commands.execute(
          { namespace: "tui", id: "escape" },
          { origin: "keyboard" },
        )
      ).status,
      "handled",
    );
    assert.equal(
      (
        await commands.execute(
          { namespace: "tui", id: "service-status" },
          { origin: "keyboard" },
        )
      ).status,
      "handled",
    );
    assert.deepEqual(calls, ["collapse", "expand"]);
  } finally {
    lease.dispose();
  }
});
