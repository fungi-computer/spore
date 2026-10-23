import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrivateLocalServiceStatus } from "@fungi.computer/truffle";
import {
  findReleaseInstall,
  pruneFungiUpdates,
  runFungiReleaseUpdate,
  restartUpdatedFungiService,
  type CommandRunner,
  type ReleaseInstall,
} from "../src/update.js";

const install: ReleaseInstall = {
  method: "npm",
  prefix: "/opt/npm",
  version: "0.0.1",
  launcher: "/opt/npm/lib/node_modules/@fungi.computer/spore/dist/fungi.cjs",
  node: "/opt/node/bin/node",
};

/** npm and the installed launcher, answering from a table of releases. */
function fakeRelease(latest: string, broken: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  let installed = install.version;
  const run: CommandRunner = (command) => {
    calls.push(command.join(" "));
    const [program, ...args] = command;
    if (program === "npm" && args[0] === "install") {
      const spec = args.at(-1) ?? "";
      installed = spec.slice(spec.lastIndexOf("@") + 1);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    if (program === install.node && args[1] === "--version")
      return Promise.resolve(
        broken.has(installed)
          ? { code: 1, stdout: "", stderr: "crash" }
          : { code: 0, stdout: `fungi ${installed}\n`, stderr: "" },
      );
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return {
    run,
    calls,
    installed: () => installed,
    registry: () => Promise.resolve(latest),
  };
}

test("update installs the npm latest release into the same global prefix", async () => {
  const updates = await mkdtemp(join(tmpdir(), "fungi-updates-"));
  const release = fakeRelease("0.0.2");
  const messages: string[] = [];
  try {
    await runFungiReleaseUpdate({
      notify: (message) => messages.push(message),
      registry: release.registry,
      run: release.run,
      install,
      updates,
    });
    expect(release.installed()).toBe("0.0.2");
    // Installation and version verification precede the new launcher's entry.
    // No old-process stop/start command or monorepo build belongs in this path.
    expect(release.calls).toEqual([
      "npm install --global --prefix /opt/npm --include=optional --no-audit --no-fund @fungi.computer/spore@0.0.2",
      `${install.node} ${install.launcher} --version`,
      `${install.node} ${install.launcher} --internal-service-restart`,
    ]);
    expect(messages.at(-1)).toBe("fungi updated 0.0.1 → 0.0.2.");
  } finally {
    await rm(updates, { recursive: true, force: true });
  }
});

test("the new installed CLI delegates replacement to its public version-checked ensure without a separate stop", async () => {
  const calls: string[] = [];
  const manager = {
    stop: () => {
      throw new Error("replacement belongs to start under the startup lock");
    },
    start: (): Promise<PrivateLocalServiceStatus> => {
      calls.push("start");
      return Promise.resolve({
        serviceId: "fixture",
        baseUrl: "http://localhost",
        pid: 123,
        protocol: 3,
        version: "fixture-new-launcher",
        diagnostics: { state: "active" },
      });
    },
  };
  await restartUpdatedFungiService(manager);
  expect(calls).toEqual(["start"]);
  const failure = new Error("The new launcher could not ensure its service");
  await assert.rejects(
    restartUpdatedFungiService({
      start: () => Promise.reject(failure),
    }),
    (cause) => cause === failure,
  );
});

test("a dead update owner leaves a reusable file lease", async () => {
  await mkdir(join(process.cwd(), ".botanical"), { recursive: true });
  const updates = await mkdtemp(
    join(process.cwd(), ".botanical/update-death-"),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/update-lock-owner.ts", import.meta.url).pathname,
      join(updates, "update-owner.sqlite"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    process.kill(child.pid, "SIGKILL");
    await child.exited;
    const release = fakeRelease("0.0.2");
    await runFungiReleaseUpdate({
      install,
      updates,
      registry: release.registry,
      run: release.run,
      notify: () => undefined,
    });
    expect(release.installed()).toBe("0.0.2");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(child.pid, "SIGKILL");
      await child.exited;
    }
    await rm(updates, { recursive: true, force: true });
  }
});

const alternateMethods: readonly ("pnpm" | "bun")[] = ["pnpm", "bun"];
for (const method of alternateMethods) {
  test(`update delegates installation to ${method} before restarting`, async () => {
    await mkdir(join(process.cwd(), ".botanical"), { recursive: true });
    const updates = await mkdtemp(
      join(process.cwd(), ".botanical/update-manager-"),
    );
    const calls: string[] = [];
    try {
      await runFungiReleaseUpdate({
        install: { ...install, method },
        updates,
        registry: () => Promise.resolve("0.0.2"),
        run: (command) => {
          calls.push(command.join(" "));
          return Promise.resolve({
            code: 0,
            stdout: command.at(-1) === "--version" ? "fungi 0.0.2" : "",
            stderr: "",
          });
        },
        notify: () => undefined,
      });
      expect(calls).toEqual([
        `${method} add --global @fungi.computer/spore@0.0.2`,
        `${install.node} ${install.launcher} --version`,
        `${install.node} ${install.launcher} --internal-service-restart`,
      ]);
    } finally {
      await rm(updates, { recursive: true, force: true });
    }
  });
}

test("an up-to-date install changes nothing", async () => {
  const release = fakeRelease("0.0.1");
  const messages: string[] = [];
  await runFungiReleaseUpdate({
    registry: release.registry,
    notify: (message) => messages.push(message),
    run: release.run,
    install,
    updates: join(tmpdir(), "fungi-updates-missing"),
  });
  expect(release.calls.filter((call) => call.includes("install"))).toEqual([]);
  expect(messages.at(-1)).toBe("fungi 0.0.1 is the latest release.");
});

test("a release that does not start is rolled back to the previous version", async () => {
  const release = fakeRelease("0.0.2", new Set(["0.0.2"]));
  let failure: unknown;
  try {
    await runFungiReleaseUpdate({
      registry: release.registry,
      notify: () => undefined,
      run: release.run,
      install,
      updates: join(tmpdir(), "fungi-updates-missing"),
    });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("fungi 0.0.1 is restored");
  expect(release.installed()).toBe("0.0.1");
});

test("a missing installed launcher receives manual reinstall guidance", async () => {
  let failure: unknown;
  try {
    await findReleaseInstall({});
  } catch (cause) {
    failure = cause;
  }
  expect(String(failure)).toContain("install.sh");
});

test("a restart failure reports the installed release without claiming success or rolling it back", async () => {
  const updates = await mkdtemp(join(tmpdir(), "fungi-update-restart-"));
  const release = fakeRelease("0.0.2");
  const messages: string[] = [];
  try {
    await assert.rejects(
      runFungiReleaseUpdate({
        install,
        updates,
        registry: release.registry,
        notify: (message) => messages.push(message),
        run: (command, env) =>
          command.at(-1) === "--internal-service-restart"
            ? Promise.resolve({
                code: 1,
                stdout: "",
                stderr: "service unavailable",
              })
            : release.run(command, env),
      }),
      /0.0.2 is installed, but its service could not restart/,
    );
    expect(release.installed()).toBe("0.0.2");
    expect(
      messages.some((message) => message.startsWith("fungi updated")),
    ).toBe(false);
  } finally {
    await rm(updates, { recursive: true, force: true });
  }
});

test("pruning keeps the active build and the newest previous one", async () => {
  const updates = await mkdtemp(join(tmpdir(), "fungi-updates-"));
  try {
    for (const [index, name] of ["a", "b", "c", "d"].entries()) {
      await mkdir(join(updates, name, "package"), { recursive: true });
      const time = new Date(Date.UTC(2026, 0, index + 1));
      await utimes(join(updates, name), time, time);
    }
    await writeFile(join(updates, "update-owner.sqlite"), "");
    await pruneFungiUpdates(
      updates,
      join(updates, "a", "package/dist/fungi.cjs"),
    );
    expect((await readdir(updates)).sort()).toEqual([
      "a",
      "d",
      "update-owner.sqlite",
    ]);
  } finally {
    await rm(updates, { recursive: true, force: true });
  }
});

test("a competing update is refused before it can invoke npm", async () => {
  const updates = await mkdtemp(join(tmpdir(), "fungi-updates-"));
  const release = fakeRelease("0.0.2");
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = runFungiReleaseUpdate({
    registry: release.registry,
    install,
    updates,
    notify: () => undefined,
    run: async (command, env) => {
      entered?.();
      await blocked;
      return release.run(command, env);
    },
  });
  try {
    await started;
    const second = fakeRelease("0.0.2");
    await assert.rejects(
      runFungiReleaseUpdate({
        registry: second.registry,
        install,
        updates,
        notify: () => undefined,
        run: second.run,
      }),
    );
    expect(second.calls).toEqual([]);
  } finally {
    unblock?.();
    await first;
    await rm(updates, { recursive: true, force: true });
  }
});

test("a compiled install.sh launcher gets reinstall guidance before any write", async () => {
  await assert.rejects(
    findReleaseInstall({
      FUNGI_LAUNCHER: "/home/user/.fungi/bin/fungi",
      FUNGI_LAUNCHER_NODE: "/home/user/.fungi/bin/fungi",
    }),
    /run the install command again/,
  );
});

test("rollback never claims restoration when the previous version cannot start", async () => {
  const updates = await mkdtemp(join(tmpdir(), "fungi-updates-"));
  const release = fakeRelease("0.0.2", new Set(["0.0.1", "0.0.2"]));
  try {
    await assert.rejects(
      runFungiReleaseUpdate({
        install,
        updates,
        run: release.run,
        registry: release.registry,
        notify: () => undefined,
      }),
      /could not be verified/,
    );
  } finally {
    await rm(updates, { recursive: true, force: true });
  }
});
