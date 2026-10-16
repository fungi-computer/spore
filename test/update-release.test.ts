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
import {
  findReleaseInstall,
  pruneFungiUpdates,
  runFungiReleaseUpdate,
  type CommandRunner,
  type ReleaseInstall,
} from "../src/update.js";

const install: ReleaseInstall = {
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
    if (program === "npm" && args[0] === "view")
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify(latest),
        stderr: "",
      });
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
  return { run, calls, installed: () => installed };
}

test("update installs the npm latest release into the same global prefix", async () => {
  const updates = await mkdtemp(join(tmpdir(), "fungi-updates-"));
  const release = fakeRelease("0.0.2");
  const messages: string[] = [];
  try {
    await runFungiReleaseUpdate({
      notify: (message) => messages.push(message),
      run: release.run,
      install,
      updates,
    });
    expect(release.installed()).toBe("0.0.2");
    expect(release.calls).toContain(`${install.node} ${install.launcher} stop`);
    expect(release.calls).toContain(
      "npm install --global --prefix /opt/npm --include=optional --no-audit --no-fund @fungi.computer/spore@0.0.2",
    );
    // Never a monorepo build.
    expect(release.calls.some((call) => /git|pnpm/u.test(call))).toBe(false);
    expect(messages.at(-1)).toBe("fungi updated 0.0.1 → 0.0.2.");
  } finally {
    await rm(updates, { recursive: true, force: true });
  }
});

test("an up-to-date install changes nothing", async () => {
  const release = fakeRelease("0.0.1");
  const messages: string[] = [];
  await runFungiReleaseUpdate({
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

test("only an npm install launched through the npm launcher can self-update", async () => {
  let failure: unknown;
  try {
    await findReleaseInstall({});
  } catch (cause) {
    failure = cause;
  }
  expect(String(failure)).toContain("install.sh");
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
        notify: () => undefined,
      }),
      /could not be verified/,
    );
  } finally {
    await rm(updates, { recursive: true, force: true });
  }
});
