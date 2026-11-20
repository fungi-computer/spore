import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterEach, expect, test } from "bun:test";
import {
  nativeFolderArchive,
  runComputerRunCommand,
  type ComputerRunOwners,
  type FolderArchive,
} from "../src/computer-run-command.js";
import { runFungiCli } from "../src/cli.js";

const endpoint = "https://hub.test/api/teams/team-1/mcp";
const prices = {
  unitsPerUsd: 100_000,
  hourly: { small: 1_500, default: 3_000, large: 6_000 },
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type SshSession = Parameters<ComputerRunOwners["ssh"]>[0];

/** The message a run rejected with, or "resolved" when it did not reject. */
async function failure<T>(run: Promise<T>) {
  return run.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
}

/**
 * Owners that record every step. `ssh` answers the push and the command from
 * `sshCodes` in order; the clock moves 20 minutes between start and delete.
 */
function fakeRun(
  options: {
    sshCodes?: number[];
    ssh?: (session: SshSession) => Promise<number>;
    overrides?: Partial<ComputerRunOwners>;
    packed?: number | "missing";
  } = {},
) {
  const steps: unknown[][] = [];
  const sessions: SshSession[] = [];
  const codes = [...(options.sshCodes ?? [0, 0])];
  let clock = 1_000;
  const stream = new PassThrough();
  const owners: ComputerRunOwners = {
    create: (endpointValue, creation) => {
      // The name is random per run; the step records that it has the shape.
      steps.push([
        "create",
        endpointValue,
        {
          ...creation,
          name: /^run-[0-9a-f]{8}$/u.test(creation.name ?? "")
            ? "run-<hex>"
            : creation.name,
        },
      ]);
      return Promise.resolve({
        kind: "created",
        requestId: "request-1",
        computer: {
          computerId: "c-1",
          name: "run-1",
          size: creation.size ?? "default",
        },
      });
    },
    start: (endpointValue, name, startOptions) => {
      steps.push(["start", endpointValue, name]);
      startOptions.onState({ state: "queued", position: 2 });
      startOptions.onState({ state: "running" });
      return Promise.resolve({ computerId: "c-1", name: "run-1" });
    },
    remove: (endpointValue, confirmed) => {
      steps.push([
        "remove",
        endpointValue,
        confirmed.computerId,
        confirmed.name,
      ]);
      clock += 20 * 60 * 1_000;
      return Promise.resolve({ ...confirmed, kind: "deleted" });
    },
    prices: () => Promise.resolve(prices),
    list: () => Promise.resolve([]),
    ssh: async (session) => {
      steps.push(["ssh", session.computer, ...session.sshArguments]);
      sessions.push(session);
      if (options.ssh !== undefined) return await options.ssh(session);
      return codes.shift() ?? 0;
    },
    archive: (folder): FolderArchive => {
      steps.push(["archive", folder]);
      stream.end("tar bytes");
      return {
        stream,
        finished: Promise.resolve(options.packed ?? 0),
        gitignore: true,
      };
    },
    now: () => clock,
    ...options.overrides,
  };
  return { owners, steps, sessions, stream };
}

function stderr() {
  let text = "";
  return {
    text: () => text,
    write: (chunk: string) => {
      text += chunk;
    },
  };
}

function signalsFake() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    signals: {
      on: (signal: string, listener: () => void) => {
        handlers.set(signal, (handlers.get(signal) ?? new Set()).add(listener));
      },
      off: (signal: string, listener: () => void) => {
        handlers.get(signal)?.delete(listener);
      },
    },
    emit: (signal: string) => {
      for (const listener of handlers.get(signal) ?? []) listener();
    },
    listening: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  };
}

test("run creates, starts, pushes, runs in /workspace, deletes, and passes the exit code through", async () => {
  const run = fakeRun({ sshCodes: [0, 3] });
  const errors = stderr();
  const fake = signalsFake();
  const code = await runComputerRunCommand(
    {
      endpoint,
      size: "small",
      push: "/home/me/app",
      command: ["npm", "test", "--", "--grep", "a b", "it's"],
      stderr: errors,
      signals: fake.signals,
    },
    run.owners,
  );
  expect(code).toBe(3);
  expect(run.steps).toEqual([
    [
      "create",
      endpoint,
      {
        name: "run-<hex>",
        size: "small",
        requestId: undefined,
      },
    ],
    ["start", endpoint, "c-1"],
    ["archive", "/home/me/app"],
    ["ssh", "c-1", "mkdir -p /workspace && tar -x -f - -C /workspace"],
    ["ssh", "c-1", "cd /workspace && npm test -- --grep 'a b' 'it'\\''s'"],
    ["remove", endpoint, "c-1", "run-1"],
  ]);
  // The push feeds the archive to ssh; the command keeps the terminal.
  expect(run.sessions[0]?.stdin).toBe(run.stream);
  expect(run.sessions[1]?.stdin).toBeUndefined();
  expect(errors.text()).toBe(
    [
      "Created run-1 (c-1), small.",
      "run-1: waiting for a machine, #2 in line",
      "Pushing /home/me/app to run-1 (files .gitignore excludes stay behind)",
      "Running npm test -- --grep 'a b' 'it'\\''s' on run-1",
      "Deleting run-1",
      "Deleted run-1.",
      "run-1 (small) was up for 20 min 0 s. Estimated cost: $0.0050, at $0.015 an hour while awake (an estimate; your bill is metered separately).",
      "",
    ].join("\n"),
  );
  expect(fake.listening()).toBe(0);
});

test("without a price from the host, the summary gives only time and size", async () => {
  const quiet = fakeRun({
    overrides: { prices: () => Promise.resolve(undefined) },
  });
  const errors = stderr();
  expect(
    await runComputerRunCommand(
      {
        endpoint,
        command: ["true"],
        stderr: errors,
        signals: signalsFake().signals,
      },
      quiet.owners,
    ),
  ).toBe(0);
  expect(errors.text()).toEndWith(
    "Deleted run-1.\nrun-1 (default) was up for 20 min 0 s.\n",
  );

  const broken = fakeRun({
    overrides: {
      prices: () =>
        Promise.reject(
          new Error("The Hub returned an invalid Computer price response."),
        ),
    },
  });
  const brokenErrors = stderr();
  expect(
    await runComputerRunCommand(
      {
        endpoint,
        command: ["true"],
        stderr: brokenErrors,
        signals: signalsFake().signals,
      },
      broken.owners,
    ),
  ).toBe(0);
  expect(brokenErrors.text()).toContain(
    "No cost estimate: The Hub returned an invalid Computer price response.\n",
  );
  expect(brokenErrors.text()).toEndWith(
    "run-1 (default) was up for 20 min 0 s.\n",
  );
});

test("a failed step names the step and its real cause, and the Computer is still deleted", async () => {
  const cases: [string, Partial<Parameters<typeof fakeRun>[0]>, string][] = [
    [
      "start",
      {
        overrides: {
          start: () =>
            Promise.reject(
              new Error(
                "The Computer didn't start: the host disk is full. Try again.",
              ),
            ),
        },
      },
      "Couldn't start run-1: The Computer didn't start: the host disk is full. Try again.",
    ],
    [
      "unpack",
      { sshCodes: [2] },
      "Couldn't push /home/me/app to run-1: unpacking on the Computer exited 2.",
    ],
    [
      "pack",
      { packed: 2 },
      "Couldn't push /home/me/app to run-1: tar exited 2 while packing it.",
    ],
    [
      "local tar",
      { packed: "missing" },
      "Couldn't push /home/me/app to run-1: tar is not installed on this machine.",
    ],
    [
      "run",
      {
        ssh: (session) =>
          session.stdin === undefined
            ? Promise.reject(
                new Error(
                  "fungi computer ssh needs the OpenSSH client (ssh and ssh-keygen) on this machine. Install OpenSSH and retry.",
                ),
              )
            : Promise.resolve(0),
      },
      "Couldn't run the command on run-1: fungi computer ssh needs the OpenSSH client (ssh and ssh-keygen) on this machine. Install OpenSSH and retry.",
    ],
  ];
  for (const [step, options, expected] of cases) {
    const run = fakeRun(options);
    const errors = stderr();
    const thrown = await failure(
      runComputerRunCommand(
        {
          endpoint,
          push: "/home/me/app",
          command: ["npm", "test"],
          stderr: errors,
          signals: signalsFake().signals,
        },
        run.owners,
      ),
    );
    expect([step, thrown]).toEqual([step, expected]);
    expect(run.steps.at(-1)).toEqual(["remove", endpoint, "c-1", "run-1"]);
    expect(errors.text()).toContain("Deleted run-1.\n");
  }
});

test("a refused or failed creation names its cause, and no Computer is deleted", async () => {
  const attempts: unknown[] = [];
  const settled = fakeRun({
    overrides: {
      create: (_endpoint, creation) => {
        attempts.push(creation.requestId);
        return Promise.resolve(
          attempts.length === 1
            ? { kind: "uncertain", requestId: "request-9" }
            : {
                kind: "created",
                requestId: "request-9",
                computer: { computerId: "c-1", name: "run-1", size: "default" },
              },
        );
      },
    },
  });
  expect(
    await runComputerRunCommand(
      {
        endpoint,
        command: ["true"],
        stderr: stderr(),
        signals: signalsFake().signals,
      },
      settled.owners,
    ),
  ).toBe(0);
  // The retry replays the Hub's creation, never a second Computer.
  expect(attempts).toEqual([undefined, "request-9"]);

  for (const [owner, expected] of [
    [
      () => Promise.resolve({ kind: "denied", requestId: "r" } as const),
      "Couldn't create a Computer: you can't create Computers in this Team; ask an owner for access.",
    ],
    [
      () =>
        Promise.reject(
          new Error(
            "The Hub did not complete Computer control. Check your Team login and access, then retry.",
          ),
        ),
      "Couldn't create a Computer: The Hub did not complete Computer control. Check your Team login and access, then retry.",
    ],
  ] as const) {
    const refused = fakeRun({ overrides: { create: owner } });
    expect(
      await failure(
        runComputerRunCommand(
          {
            endpoint,
            command: ["true"],
            stderr: stderr(),
            signals: signalsFake().signals,
          },
          refused.owners,
        ),
      ),
    ).toContain(expected);
    expect(refused.steps.some((step) => step[0] === "remove")).toBe(false);
  }
});

test("Ctrl-C during the command still deletes the Computer and exits 130", async () => {
  const fake = signalsFake();
  const run = fakeRun({
    ssh: (session) =>
      new Promise((resolve) => {
        session.signal.addEventListener(
          "abort",
          () => {
            resolve(143);
          },
          { once: true },
        );
        fake.emit("SIGINT");
      }),
  });
  const errors = stderr();
  expect(
    await runComputerRunCommand(
      {
        endpoint,
        command: ["sleep", "600"],
        stderr: errors,
        signals: fake.signals,
      },
      run.owners,
    ),
  ).toBe(130);
  expect(run.steps.at(-1)).toEqual(["remove", endpoint, "c-1", "run-1"]);
  expect(errors.text()).toContain("Stopped.\nDeleting run-1\nDeleted run-1.\n");
  expect(fake.listening()).toBe(0);
});

test("Ctrl-C while the Computer is being created lets the creation finish, then deletes it", async () => {
  const fake = signalsFake();
  const run = fakeRun({
    overrides: {
      // Like the real owner, an aborted request rejects, though the Hub may
      // already have made the Computer.
      create: (_endpoint, creation, options) =>
        new Promise((resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
          fake.emit("SIGINT");
          setTimeout(() => {
            resolve({
              kind: "created",
              requestId: "request-1",
              computer: {
                computerId: "c-1",
                name: creation.name ?? "run-1",
                size: "default",
              },
            });
          }, 5);
        }),
    },
  });
  const errors = stderr();
  expect(
    await runComputerRunCommand(
      {
        endpoint,
        command: ["true"],
        stderr: errors,
        signals: fake.signals,
      },
      run.owners,
    ),
  ).toBe(130);
  expect(run.steps.some((step) => step[0] === "start")).toBe(false);
  expect(run.steps.at(-1)?.slice(0, 3)).toEqual(["remove", endpoint, "c-1"]);
  expect(errors.text()).toContain("Stopped.\n");
  expect(fake.listening()).toBe(0);
});

test("a creation the Hub never confirms is found by its name and deleted", async () => {
  const names: (string | undefined)[] = [];
  const run = fakeRun({
    overrides: {
      create: (_endpoint, creation) => {
        names.push(creation.name);
        return Promise.resolve({ kind: "uncertain", requestId: "request-4" });
      },
      list: () =>
        Promise.resolve([
          { computerId: "c-0", name: "someone-else" },
          { computerId: "c-7", name: names[0] ?? "" },
        ]),
    },
  });
  const errors = stderr();
  expect(
    await failure(
      runComputerRunCommand(
        {
          endpoint,
          command: ["true"],
          stderr: errors,
          signals: signalsFake().signals,
        },
        run.owners,
      ),
    ),
  ).toBe(
    "Couldn't create a Computer: the Hub could not confirm it was created; run fungi computer list to check.",
  );
  // Every attempt asks for the same name, so the lookup finds the one made.
  expect(names).toHaveLength(3);
  expect(new Set(names).size).toBe(1);
  expect(names[0]).toMatch(/^run-[0-9a-f]{8}$/u);
  expect(run.steps.at(-1)).toEqual(["remove", endpoint, "c-7", names[0]]);
  expect(errors.text()).toContain(`Deleted ${names[0] ?? ""}.\n`);

  const unlisted = fakeRun({
    overrides: {
      create: () =>
        Promise.resolve({ kind: "uncertain", requestId: "request-5" }),
      list: () => Promise.reject(new Error("the Hub is unreachable")),
    },
  });
  const message = await failure(
    runComputerRunCommand(
      {
        endpoint,
        command: ["true"],
        stderr: stderr(),
        signals: signalsFake().signals,
      },
      unlisted.owners,
    ),
  );
  expect(message).toMatch(
    /^Couldn't create a Computer: the Hub could not confirm it was created; run fungi computer list to check\. Looking for it failed \(the Hub is unreachable\), so if run-[0-9a-f]{8} is listed, delete it with: fungi computer delete run-[0-9a-f]{8}$/u,
  );
  expect(unlisted.steps.some((step) => step[0] === "remove")).toBe(false);
});

test("a closed terminal (SIGHUP) while starting still deletes the Computer", async () => {
  const fake = signalsFake();
  const run = fakeRun({
    overrides: {
      start: (_endpoint, _name, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
          fake.emit("SIGHUP");
        }),
    },
  });
  expect(
    await runComputerRunCommand(
      {
        endpoint,
        command: ["true"],
        stderr: stderr(),
        signals: fake.signals,
      },
      run.owners,
    ),
  ).toBe(130);
  expect(run.steps.at(-1)?.slice(0, 3)).toEqual(["remove", endpoint, "c-1"]);
  expect(fake.listening()).toBe(0);
});

test("a delete that fails says so and names the Computer left behind", async () => {
  for (const [remove, cause] of [
    [
      (_endpoint: string, confirmed: { computerId: string; name: string }) =>
        Promise.resolve({ ...confirmed, kind: "denied" as const }),
      "only its creator or a Team owner signed in as a person can delete it",
    ],
    [
      () =>
        Promise.reject(
          new Error("The Hub returned an invalid Computer response."),
        ),
      "The Hub returned an invalid Computer response.",
    ],
  ] as const) {
    const run = fakeRun({ sshCodes: [5], overrides: { remove } });
    const errors = stderr();
    expect(
      await runComputerRunCommand(
        {
          endpoint,
          command: ["false"],
          stderr: errors,
          signals: signalsFake().signals,
        },
        run.owners,
      ),
    ).toBe(5);
    expect(errors.text()).toEndWith(
      `Deleting run-1\nCouldn't delete run-1: ${cause}. run-1 (c-1) is still in your Team and costs money while awake. Delete it with: fungi computer delete c-1\n`,
    );
  }
});

test("run without a command is refused before anything is created", async () => {
  const run = fakeRun();
  expect(
    await failure(
      runComputerRunCommand(
        {
          endpoint,
          command: [],
          stderr: stderr(),
          signals: signalsFake().signals,
        },
        run.owners,
      ),
    ),
  ).toContain(
    "fungi computer run needs a command after --, such as: fungi computer run -- npm test",
  );
  expect(run.steps).toEqual([]);
});

async function tarNames(stream: Readable): Promise<string[]> {
  return execFileSync("tar", ["-t", "-f", "-"], {
    input: await buffer(stream),
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((name) => name.replace(/^\.\//u, "").replace(/\/$/u, ""))
    .filter((name) => name !== "" && name !== ".")
    .toSorted();
}

test("--push packs what Git keeps in a Git folder, and every file elsewhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-run-archive-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  await writeFile(join(root, ".gitignore"), "secret.env\nnode_modules/\n");
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "gone.txt"), "tracked, then deleted\n");
  await writeFile(join(root, "secret.env"), "TOKEN=1\n");
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await writeFile(join(root, "node_modules", "dep", "index.js"), "\n");
  git("add", ".gitignore", "package.json", "gone.txt");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    "init",
  );
  await unlink(join(root, "gone.txt"));
  await writeFile(join(root, "new.txt"), "untracked, not ignored\n");

  // A nested repository Git records as one entry: none of its files go,
  // since its own .gitignore is not this folder's.
  const nested = join(root, "vendor");
  await mkdir(nested);
  execFileSync("git", ["-C", nested, "init", "-q"], { stdio: "ignore" });
  await writeFile(join(nested, ".gitignore"), "nested.env\n");
  await writeFile(join(nested, "nested.env"), "TOKEN=2\n");
  execFileSync("git", ["-C", nested, "add", ".gitignore"], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      nested,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "init",
    ],
    { stdio: "ignore" },
  );
  git("add", "vendor");

  const kept = nativeFolderArchive(root);
  expect(kept.gitignore).toBe(true);
  expect(await tarNames(kept.stream)).toEqual([
    ".gitignore",
    "new.txt",
    "package.json",
    "vendor",
  ]);
  expect(await kept.finished).toBe(0);

  const plain = await mkdtemp(join(tmpdir(), "fungi-run-plain-"));
  roots.push(plain);
  await writeFile(join(plain, "secret.env"), "TOKEN=1\n");
  await writeFile(join(plain, "main.sh"), "echo hi\n");
  const whole = nativeFolderArchive(plain);
  expect(whole.gitignore).toBe(false);
  expect(await tarNames(whole.stream)).toEqual(["main.sh", "secret.env"]);
  expect(await whole.finished).toBe(0);
});

test("fungi computer run takes --size, --push and the command after --", async () => {
  const run = fakeRun({ sshCodes: [0, 4] });
  const folder = await mkdtemp(join(tmpdir(), "fungi-run-cli-"));
  roots.push(folder);
  const previous = process.exitCode;
  try {
    await runFungiCli(
      [
        "computer",
        "run",
        "--size",
        "large",
        "--push",
        folder,
        "--fungi-mcp",
        endpoint,
        "--",
        "npm",
        "test",
        "--watch=false",
      ],
      { stderr: { write: () => true } },
      { computerRunOwners: run.owners },
    );
    expect(process.exitCode).toBe(4);
  } finally {
    // Bun ignores `process.exitCode = undefined`, which would leave the run's
    // exit code 4 as the whole suite's exit status.
    process.exitCode = previous ?? 0;
  }
  expect(run.steps[0]).toEqual([
    "create",
    endpoint,
    {
      name: "run-<hex>",
      size: "large",
      requestId: undefined,
    },
  ]);
  expect(run.steps[2]).toEqual(["archive", folder]);
  expect(run.steps[4]).toEqual([
    "ssh",
    "c-1",
    "cd /workspace && npm test --watch=false",
  ]);
  expect(
    await failure(
      runFungiCli(
        ["computer", "list", "--push", folder, "--fungi-mcp", endpoint],
        {
          stderr: { write: () => true },
        },
      ),
    ),
  ).toContain("--push is only valid with fungi computer run");
});
