import { expect, test } from "bun:test";
import { createWhistle } from "@fungi.computer/whistle";
import { contributeTerminalCommands } from "../src/panes/conversation/terminal-commands.js";
import {
  stopAllFailure,
  stopAllSummary,
} from "../src/panes/conversation/stop-all-summary.js";
import {
  createToastStore,
  toastQueueLimit,
} from "../src/button/toast-store.js";

test("/stop all invokes the same tree stop once even while the parent is idle", async () => {
  const commands = createWhistle();
  let calls = 0;
  const lease = contributeTerminalCommands(commands, {
    canCancel: false,
    canRetry: false,
    canContinue: false,
    cancel: () =>
      Promise.reject(new Error("Must not cancel only the current turn")),
    stopAll: () => {
      calls++;
      return Promise.resolve();
    },
    reconnect: () =>
      Promise.resolve({
        kind: "nothing_to_reconnect",
        state: "connected",
      }),
    retry: () => false,
    continue: () => Promise.resolve(false),
    details: () => undefined,
    toolGroup: () => undefined,
  });
  try {
    const result = await commands.execute(
      { namespace: "tui", id: "stop" },
      {
        origin: "slash",
        arguments: { scope: "all" },
      },
    );
    expect(result.status).toBe("handled");
    expect(calls).toBe(1);
    const invalid = await commands.execute(
      { namespace: "tui", id: "stop" },
      {
        origin: "slash",
        arguments: { scope: "other" },
      },
    );
    expect(invalid.status).toBe("failed");
    expect(calls).toBe(1);
  } finally {
    lease.dispose();
  }
});

test("the single summary counts stopped helpers, not idle helpers, and names partial failures", () => {
  const agents = [
    { agentId: "leaf", name: "Leaf", outcome: "stopped" },
    { agentId: "child", name: "Child", outcome: "stopped" },
    { agentId: "idle", name: "Idle", outcome: "idle" },
    { agentId: "root", name: "Shiitake", outcome: "stopped" },
  ] satisfies Parameters<typeof stopAllSummary>[0]["agents"];
  expect(
    stopAllSummary({ rootAgentId: "root", agents, discoveryFailures: [] }),
  ).toEqual({
    variant: "success",
    message: "Stopped Shiitake and 2 helpers",
  });
  expect(
    stopAllSummary({
      rootAgentId: "root",
      agents: [
        ...agents,
        {
          agentId: "remote",
          name: "Remote",
          outcome: "failed",
          reason: "Unavailable host",
        },
      ],
      discoveryFailures: [],
    }),
  ).toEqual({
    variant: "warning",
    duration: "until-dismissed",
    message:
      "Stopped Shiitake and 2 helpers. 1 not confirmed: Remote: Unavailable host",
  });
});

test("the final toast store retains a queued stop-all refusal under transient pressure until acknowledged", () => {
  const store = createToastStore();
  const warning = stopAllFailure(new Error("Service refused the cascade"));
  try {
    store.show({ variant: "info", message: "Existing toast" });
    store.show(warning);
    for (let index = 0; index <= toastQueueLimit; index++)
      store.show(
        stopAllSummary({
          rootAgentId: "root",
          agents: [],
          discoveryFailures: [],
        }),
      );
    expect(store.snapshot().pending).toBe(toastQueueLimit);
    store.dismiss();
    expect(store.snapshot().current).toMatchObject(warning);
    store.pause();
    store.resume();
    expect(store.snapshot().current?.duration).toBe("until-dismissed");
    store.dismiss();
    expect(store.snapshot().current?.variant).toBe("success");
  } finally {
    store.dispose();
  }
});

test("a late stop-all reply cannot resurrect the final toast store after toast-owner teardown", async () => {
  const store = createToastStore();
  const response = Promise.withResolvers<undefined>();
  const late = response.promise.then(() => {
    store.show(stopAllFailure(new Error("Late transport refusal")));
  });
  let publications = 0;
  store.subscribe(() => {
    publications++;
  });
  store.dispose();
  response.resolve(undefined);
  await late;
  expect(publications).toBe(0);
  expect(store.snapshot()).toEqual({ current: undefined, pending: 0 });
});
