import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import { sleep, spawn } from "bun";
import { z } from "zod";
import { createIsolatedCliEnvironment } from "./cli-test-isolation.js";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle/service";

const fungiEntry = join(import.meta.dir, "..", "src", "cli.tsx");
const recordSchema = z.looseObject({
  protocol: z.number(),
  version: z.string(),
  pid: z.number(),
});

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

test("an uninstalled source CLI cannot replace the installed service; explicit fungi stop still works", async () => {
  const isolated = await createIsolatedCliEnvironment();
  const home = isolated.home;
  const directory = join(home, ".fungi", "service");
  const record = join(directory, "service.json");
  const project = join(home, "project");
  await mkdir(project);
  // The manager creates the private directory before it spawns a service.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bin = join(home, "prefix/bin");
  const dist = join(home, "prefix/dist");
  await mkdir(bin, { recursive: true });
  await mkdir(dist);
  const launcher = join(dist, "fungi.cjs");
  const cli = join(dist, "cli.js");
  await copyFile(join(import.meta.dir, "../scripts/fungi.cjs"), launcher);
  await chmod(launcher, 0o755);
  await symlink(launcher, join(bin, "fungi"));
  const fixture = pathToFileURL(
    join(
      import.meta.dir,
      "../../../runtimes/local/test/fixtures/installed-service-client.ts",
    ),
  ).href;
  await writeFile(
    cli,
    `import { run } from ${JSON.stringify(fixture)};\nawait run();\n`,
  );
  const installedBuild = createHash("sha256")
    .update(await readFile(cli))
    .digest("hex");
  // Every fungi process here runs as a source build in the throwaway HOME.
  const env = Object.fromEntries(
    Object.entries({
      ...isolated.env,
      TMPDIR: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_DATA_HOME: join(home, "data"),
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    }).filter(([name]) => name !== "FUNGI_BUNDLED_BUILD_ID"),
  );
  /** Run the real fungi command the way a person does, in its own process. */
  const fungi = async (...args: string[]) => {
    const child = spawn([process.execPath, fungiEntry, ...args], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  // The installed build's real service, started through fungi's own entry.
  const stale = spawn(
    [process.execPath, fungiEntry, "--internal-service", directory],
    {
      env: { ...env, FUNGI_BUNDLED_BUILD_ID: installedBuild },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  try {
    for (let attempt = 0; attempt < 400 && !(await exists(record)); attempt++)
      await sleep(25);
    const before = recordSchema.parse(
      JSON.parse(await readFile(record, "utf8")),
    );
    expect(before).toMatchObject({ version: installedBuild, pid: stale.pid });

    const blocked = await fungi("sessions", "list", "-C", project);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("Restart this window.");
    expect(stale.exitCode).toBeNull();
    expect(
      recordSchema.parse(JSON.parse(await readFile(record, "utf8"))),
    ).toEqual(before);
    expect((await fungi("stop")).exitCode).toBe(0);
    await stale.exited;

    expect(await fungi("sessions", "list", "-C", project)).toEqual({
      stdout: `No saved conversations in ${project}.\n`,
      stderr: "",
      exitCode: 0,
    });
    await stale.exited;
    expect(stale.signalCode).toBeNull();
    const after = recordSchema.parse(
      JSON.parse(await readFile(record, "utf8")),
    );
    expect(after).toMatchObject({ protocol: 4, version: "source" });
    expect(after.pid).not.toBe(stale.pid);

    expect(await fungi("stop")).toEqual({
      stdout: "Local service stopped. Saved Sessions preserved.\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await exists(record)).toBe(false);
  } finally {
    stale.kill("SIGKILL");
    await stale.exited;
    await createPrivateLocalServiceManager({ directory }).stop();
    await isolated.cleanup();
  }
}, 60_000);
