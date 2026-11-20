import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import type { PrivateLocalScheduleCapability } from "@fungi.computer/truffle/service";
import { runFungiCli } from "../src/cli.js";
import { runSchedulesCommand } from "../src/schedules-command.js";

const folder = "/project";
type Capability = PrivateLocalScheduleCapability;
type Row = Awaited<ReturnType<Capability["list"]>>["items"][number];
type Page = Awaited<ReturnType<Capability["list"]>>;

const inbox: Row = {
  agentId: "local_store_fixer",
  kind: "almanac",
  schedule: {
    id: "inbox-weekdays",
    sessionId: "garden",
    prompt: "Summarise my inbox",
    cron: { expression: "0 8 * * 1-5", timeZone: "Europe/Berlin" },
    nextDueAt: Date.UTC(2026, 10, 24, 7, 0),
    state: "active",
    lastCommandId: null,
    lastError: null,
    attempt: 0,
  },
};
const watch: Row = {
  agentId: "local_store_watcher",
  kind: "loop",
  schedule: {
    loopId: "loop_1",
    sessionId: "ci",
    origin: "human",
    expiresAt: null,
    prompt: "Check the build\u001b[31m and report",
    mode: "self_paced",
    cron: null,
    state: "paused",
    commandId: "cmd_1",
    reason: null,
    nextDueAt: null,
    lastError: null,
    consecutiveFailures: 0,
  },
};

function harness(pages: readonly Page[], overrides: Partial<Capability> = {}) {
  const calls: unknown[][] = [];
  let next = 0;
  const capability: Capability = {
    list: (input) => {
      calls.push(["list", input]);
      const page = pages[next];
      next += 1;
      if (page === undefined) throw new Error("No more pages");
      return Promise.resolve(page);
    },
    pause: (target) => {
      calls.push(["pause", target]);
      return Promise.resolve(inbox);
    },
    delete: (target) => {
      calls.push(["delete", target]);
      return Promise.resolve(inbox);
    },
    ...overrides,
  };
  let out = "";
  const run = async (
    action: "list" | "pause" | "delete",
    extra: {
      agentId?: string;
      ref?: string;
      yes?: boolean;
      confirm?: (question: string) => Promise<boolean>;
    } = {},
  ) => {
    await runSchedulesCommand({
      action,
      agentId: extra.agentId,
      ref: extra.ref,
      yes: extra.yes ?? false,
      confirm: extra.confirm,
      invocationRoot: folder,
      manager: {
        schedules: (root) => {
          calls.push(["root", root]);
          return capability;
        },
      },
      stdout: {
        write: (text) => {
          out += text;
        },
      },
    });
  };
  return { run, calls, out: () => out };
}

const page = (
  items: Row[],
  next: Page["next"] = null,
  unavailable: Page["unavailable"] = [],
): Page => ({ items, unavailable, next });

test("fungi schedules list prints every retained schedule with its ref, state and cadence, across pages", async () => {
  const test = harness([
    page([inbox], { agentId: "local_store_watcher", kind: "loop" }),
    page([watch]),
  ]);
  await test.run("list");
  expect(test.out()).toBe(
    [
      "local_store_fixer    almanac:inbox-weekdays  active  0 8 * * 1-5 Europe/Berlin  next 2026-11-24T07:00:00.000Z  Summarise my inbox",
      "local_store_watcher  loop:ci/loop_1          paused  self-paced                 next none                      Check the build and report",
      "",
    ].join("\n"),
  );
  expect(test.calls[0]).toEqual(["root", folder]);
  expect(test.calls.filter(([name]) => name === "list")).toHaveLength(2);
  expect(test.calls[2]).toEqual([
    "list",
    { after: { agentId: "local_store_watcher", kind: "loop" } },
  ]);
});

test("a folder with no schedules says so only when every owner answered", async () => {
  const empty = harness([page([])]);
  await empty.run("list");
  expect(empty.out()).toBe("No schedules in /project.\n");
});

test("an Agent whose schedules could not be read is named, never reported as an empty list", async () => {
  const onlyUnavailable = harness([
    page([], null, [
      { agentId: "local_store_fixer", reason: "owner_unavailable" },
    ]),
  ]);
  await assert.rejects(onlyUnavailable.run("list"), {
    message:
      "Couldn't read every schedule in /project: local_store_fixer unavailable (its Agent could not be opened). Try again, or stop the Agent's running command first.",
  });
  expect(onlyUnavailable.out()).not.toContain("No schedules");
  const partial = harness([
    page([watch], null, [
      { agentId: "local_store_fixer", reason: "owner_unavailable" },
    ]),
  ]);
  await assert.rejects(partial.run("list"), {
    message: /local_store_fixer unavailable/u,
  });
  expect(partial.out()).toContain("loop:ci/loop_1");
});

test("pause targets the exact listed schedule, an Almanac id or a Loop's session and loop", async () => {
  const almanac = harness([page([inbox, watch])]);
  await almanac.run("pause", {
    agentId: "local_store_fixer",
    ref: "almanac:inbox-weekdays",
  });
  expect(almanac.calls.at(-1)).toEqual([
    "pause",
    {
      kind: "almanac",
      agentId: "local_store_fixer",
      scheduleId: "inbox-weekdays",
    },
  ]);
  expect(almanac.out()).toBe(
    "Paused almanac:inbox-weekdays. Future occurrences stop; its conversation can resume it. Work already accepted stays.\n",
  );
  const loop = harness([page([inbox, watch])]);
  await loop.run("pause", {
    agentId: "local_store_watcher",
    ref: "loop:ci/loop_1",
  });
  expect(loop.calls.at(-1)).toEqual([
    "pause",
    {
      kind: "loop",
      agentId: "local_store_watcher",
      sessionId: "ci",
      loopId: "loop_1",
    },
  ]);
});

test("a ref that is not in the folder pauses nothing and says which one", async () => {
  const test = harness([page([inbox])]);
  await assert.rejects(
    test.run("pause", { agentId: "local_store_fixer", ref: "almanac:gone" }),
    {
      message:
        "Couldn't pause almanac:gone: local_store_fixer has no such schedule in /project. Run fungi schedules list.",
    },
  );
  expect(test.calls.some(([name]) => name === "pause")).toBe(false);
});

test("delete asks first, takes --yes, and keeps accepted work and history", async () => {
  const yes = harness([page([inbox])]);
  await yes.run("delete", {
    agentId: "local_store_fixer",
    ref: "almanac:inbox-weekdays",
    yes: true,
  });
  expect(yes.calls.at(-1)).toEqual([
    "delete",
    {
      kind: "almanac",
      agentId: "local_store_fixer",
      scheduleId: "inbox-weekdays",
    },
  ]);
  expect(yes.out()).toBe(
    "Deleted almanac:inbox-weekdays. Future occurrences are cancelled; work already accepted and its history stay.\n",
  );
  const questions: string[] = [];
  const declined = harness([page([inbox])]);
  await declined.run("delete", {
    agentId: "local_store_fixer",
    ref: "almanac:inbox-weekdays",
    confirm: (question) => {
      questions.push(question);
      return Promise.resolve(false);
    },
  });
  expect(questions).toEqual([
    "Delete almanac:inbox-weekdays (Summarise my inbox)? Future occurrences are cancelled. [y/N] ",
  ]);
  expect(declined.out()).toBe("Not deleted.\n");
  expect(declined.calls.some(([name]) => name === "delete")).toBe(false);
  const noTerminal = harness([page([inbox])]);
  await assert.rejects(
    noTerminal.run("delete", {
      agentId: "local_store_fixer",
      ref: "almanac:inbox-weekdays",
    }),
    { message: "fungi schedules delete needs --yes without a terminal" },
  );
});

test("a refusal from the schedule's owner is shown with its own cause", async () => {
  const test = harness([page([inbox])], {
    pause: () => Promise.reject(new Error("Schedule is already paused")),
  });
  await assert.rejects(
    test.run("pause", {
      agentId: "local_store_fixer",
      ref: "almanac:inbox-weekdays",
    }),
    {
      message:
        "Couldn't pause almanac:inbox-weekdays: Schedule is already paused.",
    },
  );
});

test("fungi schedules takes list, pause and delete only: there is no Resume", async () => {
  let output = "";
  await assert.rejects(
    runFungiCli(
      ["schedules", "resume", "local_store_fixer", "almanac:x", "-C", folder],
      {
        stdout: {
          write(chunk) {
            output += String(chunk);
            return true;
          },
        },
      },
      {
        createServiceManager: () => {
          throw new Error("unused");
        },
      },
    ),
    { message: /Usage: fungi schedules list/u },
  );
  expect(output).toBe("");
});
