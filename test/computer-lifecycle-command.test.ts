import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { runFungiCli } from "../src/cli.js";
import {
  runComputerLifecycleCommand,
  type ComputerLifecycleOwners,
} from "../src/computer-lifecycle-command.js";

const endpoint = "https://hub.test/api/teams/team-1/mcp";
const cedar = { computerId: "computer_cedar", name: "cedar", size: "small" };

type Calls = unknown[][];

function harness(overrides: Partial<ComputerLifecycleOwners> = {}) {
  const calls: Calls = [];
  const ids: (string | undefined)[] = [];
  const owners: Partial<ComputerLifecycleOwners> = {
    list: (rawEndpoint) => {
      calls.push(["list", rawEndpoint]);
      return Promise.resolve([
        { ...cedar, state: "running" as const },
        {
          computerId: "computer_fern",
          name: "fern",
          size: "default",
          state: "queued" as const,
          position: 3,
        },
      ]);
    },
    describe: (rawEndpoint, name) => {
      calls.push(["describe", rawEndpoint, name]);
      return Promise.resolve({ ...cedar, state: "sleeping" as const });
    },
    create: (rawEndpoint, creation) => {
      calls.push(["create", rawEndpoint, creation]);
      ids.push(creation.requestId);
      return Promise.resolve({
        kind: "created" as const,
        requestId: creation.requestId ?? "hub-minted",
        computer: {
          computerId: "computer_new",
          name: creation.name ?? "generated-name",
          size: creation.size ?? ("default" as const),
        },
      });
    },
    stop: (rawEndpoint, name) => {
      calls.push(["stop", rawEndpoint, name]);
      return Promise.resolve({
        computerId: "computer_cedar",
        name: "cedar",
        kind: "stopped" as const,
      });
    },
    remove: (rawEndpoint, confirmed) => {
      calls.push(["remove", rawEndpoint, confirmed]);
      return Promise.resolve({
        computerId: "computer_cedar",
        name: "cedar",
        kind: "deleted" as const,
      });
    },
    start: (rawEndpoint, name, options) => {
      calls.push(["start", rawEndpoint, name]);
      options.onState({ state: "queued", position: 2 });
      return Promise.resolve({ computerId: "computer_cedar", name: "cedar" });
    },
    ...overrides,
  };
  let out = "";
  let err = "";
  const run = async (...args: string[]) => {
    await runFungiCli(
      ["computer", ...args, "--fungi-mcp", endpoint],
      {
        stdout: {
          write: (chunk) => {
            out += String(chunk);
            return true;
          },
        },
        stderr: {
          write: (chunk) => {
            err += String(chunk);
            return true;
          },
        },
      },
      { computerLifecycleOwners: owners },
    );
  };
  return { calls, ids, run, out: () => out, err: () => err };
}

test("fungi computer list prints every Computer's real state, and one JSON document with --json", async () => {
  const text = harness();
  await text.run("list");
  expect(text.out()).toBe(
    "cedar (computer_cedar): running\nfern (computer_fern): queued #3\n",
  );
  const json = harness();
  await json.run("list", "--json");
  expect(JSON.parse(json.out())).toEqual({
    computers: [
      { ...cedar, state: "running" },
      {
        computerId: "computer_fern",
        name: "fern",
        size: "default",
        state: "queued",
        position: 3,
      },
    ],
  });
  expect(json.calls).toEqual([["list", endpoint]]);
});

test("fungi computer info reads one Computer without waking it", async () => {
  const text = harness();
  await text.run("info", "cedar");
  expect(text.out()).toBe("cedar (computer_cedar): sleeping, small\n");
  const json = harness();
  await json.run("info", "cedar", "--json");
  expect(JSON.parse(json.out())).toEqual({
    computer: { ...cedar, state: "sleeping" },
  });
  expect(json.calls).toEqual([["describe", endpoint, "cedar"]]);
});

test("fungi computer new sends the name and size, lets the Hub mint the request id and prints the start command", async () => {
  const run = harness();
  await run.run("new", "cedar", "--size", "small");
  expect(run.calls).toEqual([
    [
      "create",
      endpoint,
      { name: "cedar", size: "small", requestId: undefined },
    ],
  ]);
  expect(run.out()).toBe(
    "Created cedar (computer_new), small. Start it with: fungi computer start cedar\n",
  );
  const json = harness();
  await json.run("new", "--json");
  expect(JSON.parse(json.out())).toEqual({
    computer: {
      computerId: "computer_new",
      name: "generated-name",
      size: "default",
    },
  });
  expect(json.ids).toEqual([undefined]);
});

test("an unconfirmed creation is retried under the Hub's request id, never as a second creation", async () => {
  const requests: (string | undefined)[] = [];
  const run = harness({
    create: (_endpoint, creation) => {
      requests.push(creation.requestId);
      return Promise.resolve(
        requests.length < 3
          ? { kind: "uncertain" as const, requestId: "hub-1" }
          : {
              kind: "created" as const,
              requestId: "hub-1",
              computer: { ...cedar, size: "small" as const },
            },
      );
    },
  });
  await run.run("new", "cedar");
  // The first attempt names no id; each retry sends back the one the Hub returned.
  expect(requests).toEqual([undefined, "hub-1", "hub-1"]);
  expect(run.out()).toContain("Created cedar");
});

test("a refused creation names its cause in plain words", async () => {
  const cases = [
    [
      "denied",
      "You can't create Computers in this Team. Ask an owner for access.",
    ],
    [
      "conflict",
      "A Computer named cedar already exists in this Team. Choose another name.",
    ],
    [
      "invalid",
      "The Hub rejected that name or size. Names are 1 to 256 characters; sizes are small, default or large.",
    ],
    [
      "uncertain",
      "The Hub could not confirm the Computer was created. Run fungi computer list before trying again.",
    ],
  ] as const;
  for (const [kind, sentence] of cases) {
    let attempts = 0;
    const run = harness({
      create: (_endpoint, creation) => {
        attempts += 1;
        return Promise.resolve({
          kind,
          requestId: creation.requestId ?? "hub-1",
        });
      },
    });
    await assert.rejects(run.run("new", "cedar"), { message: sentence });
    // Only an unconfirmed creation is retried.
    expect(attempts).toBe(kind === "uncertain" ? 3 : 1);
  }
});

test("fungi computer start shows the queue place, and --json keeps stdout to one document", async () => {
  const json = harness();
  await json.run("start", "cedar", "--json");
  expect(JSON.parse(json.out())).toEqual({
    computer: { computerId: "computer_cedar", name: "cedar" },
    state: "running",
  });
  expect(json.err()).toBe("cedar: queued #2\n");
  expect(json.calls).toEqual([["start", endpoint, "cedar"]]);
});

test("--size is only for new and only takes a real size", async () => {
  const run = harness();
  await assert.rejects(run.run("list", "--size", "small"), {
    message: "--size is only valid with fungi computer new",
  });
  await assert.rejects(run.run("new", "--size", "huge"), {
    message: "--size takes small, default or large",
  });
  expect(run.calls).toEqual([]);
});

test("fungi computer stop keeps the files and names why a stop was refused", async () => {
  const run = harness();
  await run.run("stop", "cedar");
  expect(run.out()).toBe(
    "Stopped cedar. Its files are kept; fungi computer start cedar brings it back.\n",
  );
  const json = harness();
  await json.run("stop", "cedar", "--json");
  expect(JSON.parse(json.out())).toEqual({
    computer: { computerId: "computer_cedar", name: "cedar" },
    state: "sleeping",
  });
  const cases = [
    ["denied", "You can't stop cedar. Only its creator or a Team owner can."],
    [
      "busy",
      "cedar is starting or finishing an operation. Try again in a moment.",
    ],
    [
      "uncertain",
      "The Hub could not confirm cedar stopped. Run fungi computer info cedar, then try again.",
    ],
  ] as const;
  for (const [kind, sentence] of cases) {
    const refused = harness({
      stop: () =>
        Promise.resolve({ computerId: "computer_cedar", name: "cedar", kind }),
    });
    await assert.rejects(refused.run("stop", "cedar"), { message: sentence });
  }
});

test("fungi computer delete with --yes deletes under the Computer's own name, by name or id", async () => {
  const run = harness();
  await run.run("delete", "computer_cedar", "--yes");
  expect(run.calls).toEqual([
    ["describe", endpoint, "computer_cedar"],
    ["remove", endpoint, { computerId: "computer_cedar", name: "cedar" }],
  ]);
  expect(run.out()).toBe("Deleted cedar and erased its files.\n");
  const json = harness();
  await json.run("delete", "cedar", "--yes", "--json");
  expect(JSON.parse(json.out())).toEqual({
    deleted: { computerId: "computer_cedar", name: "cedar" },
  });
});

test("fungi computer delete asks first, and does nothing on a no or without a terminal", async () => {
  const asked: string[] = [];
  const base = {
    action: "delete" as const,
    computer: "cedar",
    endpoint,
    json: false,
    yes: false,
    stderr: { write: () => undefined },
    cli: {
      task: () => Promise.reject(new Error("unused")),
      step: () => undefined,
      outro: () => undefined,
      cancel: () => undefined,
    },
  };
  const calls: Calls = [];
  const owners: ComputerLifecycleOwners = {
    list: () => Promise.reject(new Error("unused")),
    create: () => Promise.reject(new Error("unused")),
    start: () => Promise.reject(new Error("unused")),
    stop: () => Promise.reject(new Error("unused")),
    describe: (_endpoint, name) => {
      calls.push(["describe", name]);
      return Promise.resolve({ ...cedar, state: "sleeping" as const });
    },
    remove: (_endpoint, confirmed) => {
      calls.push(["remove", confirmed.name]);
      return Promise.resolve({
        computerId: "computer_cedar",
        name: "cedar",
        kind: "deleted" as const,
      });
    },
  };
  let out = "";
  const stdout = {
    write: (text: string) => {
      out += text;
    },
  };
  // A no deletes nothing.
  await runComputerLifecycleCommand(
    {
      ...base,
      stdout,
      confirm: (question) => {
        asked.push(question);
        return Promise.resolve(false);
      },
    },
    owners,
  );
  expect(asked).toEqual([
    "Delete cedar (computer_cedar) and erase its files? This cannot be undone. [y/N] ",
  ]);
  expect(out).toBe("Not deleted.\n");
  expect(calls).toEqual([["describe", "cedar"]]);
  // A yes deletes.
  await runComputerLifecycleCommand(
    { ...base, stdout, confirm: () => Promise.resolve(true) },
    owners,
  );
  expect(calls.at(-1)).toEqual(["remove", "cedar"]);
  // No terminal and no --yes: refused before anything is erased.
  const before = calls.length;
  await assert.rejects(
    runComputerLifecycleCommand(
      { ...base, stdout, confirm: undefined },
      owners,
    ),
    { message: "fungi computer delete needs --yes without a terminal" },
  );
  await assert.rejects(
    runComputerLifecycleCommand(
      { ...base, stdout, json: true, confirm: () => Promise.resolve(true) },
      owners,
    ),
    { message: "fungi computer delete --json needs --yes" },
  );
  expect(
    calls.slice(before).every(([operation]) => operation === "describe"),
  ).toBe(true);
});

test("fungi computer delete names why it was refused, and a refusal erases nothing more", async () => {
  const cases = [
    ["denied", "You can't delete cedar. Only its creator or a Team owner can."],
    [
      "mismatch",
      "The Hub did not accept cedar as the Computer's name. Run fungi computer list and try again.",
    ],
    [
      "unsupported",
      "This host can't delete a Computer from the terminal. Delete it from its settings.",
    ],
    [
      "uncertain",
      "Deleting cedar did not finish. Run the same command again to finish it.",
    ],
  ] as const;
  for (const [kind, sentence] of cases) {
    const run = harness({
      remove: () =>
        Promise.resolve({ computerId: "computer_cedar", name: "cedar", kind }),
    });
    await assert.rejects(run.run("delete", "cedar", "--yes"), {
      message: sentence,
    });
  }
});

/** A Team whose listing the test can change, answering delete as the Hub does. */
function changingTeam() {
  let computers = [{ computerId: "computer_cedar", name: "cedar" }];
  const erased: string[] = [];
  const owners: Partial<ComputerLifecycleOwners> = {
    describe: (_endpoint, selector) => {
      const found = computers.find(
        (computer) =>
          computer.computerId === selector || computer.name === selector,
      );
      if (found === undefined) return Promise.reject(new Error("No Computer"));
      return Promise.resolve({
        ...found,
        size: "small",
        state: "sleeping" as const,
      });
    },
    // The Hub's own rule: the id must still be listed under the confirmed name.
    remove: (_endpoint, confirmed) => {
      const found = computers.find(
        (computer) => computer.computerId === confirmed.computerId,
      );
      if (found === undefined)
        return Promise.resolve({ ...confirmed, kind: "denied" as const });
      if (found.name !== confirmed.name)
        return Promise.resolve({ ...confirmed, kind: "mismatch" as const });
      erased.push(found.computerId);
      computers = computers.filter(
        (computer) => computer.computerId !== found.computerId,
      );
      return Promise.resolve({ ...confirmed, kind: "deleted" as const });
    },
  };
  return {
    erased,
    owners,
    rename: (name: string) => {
      computers = computers.map((computer) => ({ ...computer, name }));
    },
    replace: () => {
      computers = [{ computerId: "computer_impostor", name: "cedar" }];
    },
  };
}

test("a Computer renamed or replaced while the delete question is open is not deleted", async () => {
  for (const change of ["rename", "replace"] as const) {
    const team = changingTeam();
    let out = "";
    const run = runComputerLifecycleCommand(
      {
        action: "delete",
        computer: "cedar",
        endpoint,
        json: false,
        yes: false,
        // The listing changes after the person was asked, before they answer.
        confirm: () => {
          if (change === "rename") team.rename("birch");
          else team.replace();
          return Promise.resolve(true);
        },
        stdout: {
          write: (text: string) => {
            out += text;
          },
        },
        stderr: { write: () => undefined },
        cli: {
          task: () => Promise.reject(new Error("unused")),
          step: () => undefined,
          outro: () => undefined,
          cancel: () => undefined,
        },
      },
      {
        list: () => Promise.reject(new Error("unused")),
        create: () => Promise.reject(new Error("unused")),
        start: () => Promise.reject(new Error("unused")),
        stop: () => Promise.reject(new Error("unused")),
        describe: () => Promise.reject(new Error("unused")),
        remove: () => Promise.reject(new Error("unused")),
        ...team.owners,
      },
    );
    await assert.rejects(run, {
      message:
        change === "rename"
          ? "The Hub did not accept cedar as the Computer's name. Run fungi computer list and try again."
          : "You can't delete cedar. Only its creator or a Team owner can.",
    });
    expect(team.erased).toEqual([]);
    expect(out).toBe("");
  }
});
