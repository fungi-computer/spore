import {
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { acquireNodeStoreLease } from "@fungi.computer/shiitake/node";
import { buildIntegrationCandidate } from "./update-build.js";
import {
  proveFungiCandidate,
  type FungiCandidateProof,
} from "./update-proof.js";
import { installFungiCandidate, installedFungiLink } from "./update-install.js";
import { latestFungiVersion, releaseVersion } from "./release-registry.js";
import {
  expectReportedVersion,
  reportedVersion,
} from "@fungi.computer/cli-version";
import type { PrivateLocalServiceManager } from "@fungi.computer/truffle/service";

/** The new launcher's fresh manager owns version-checked replacement under its startup lock. */
export async function restartUpdatedFungiService(
  manager: Pick<PrivateLocalServiceManager, "start">,
): Promise<void> {
  await manager.start();
}

/**
 * Spore owns release install/update/rollback. The detected package manager
 * owns tarball integrity and global installation; the registry owns latest.
 * Only the newly installed launcher restarts the service, with its new build
 * identity, after verification. A failed install leaves the old service alone.
 */
const releasePackage = "@fungi.computer/spore";

export type CommandResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;
export type CommandRunner = (
  command: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

const execute = promisify(execFile);
const managerEnvironment = (node: string) => ({
  PATH: `${dirname(node)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
});
const commandFailure = z.object({
  code: z.union([z.number(), z.string().transform(() => 1)]),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
export function releaseCommandTimeout(command: readonly string[]): number {
  const operation = command[1];
  return operation === "root" || operation === "prefix" || operation === "pm"
    ? 5_000
    : 300_000;
}

const runCommand: CommandRunner = async (command, env) => {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("Missing update command");
  try {
    const result = await execute(program, args, {
      env: { ...process.env, ...env },
      timeout: releaseCommandTimeout(command),
      maxBuffer: 1_048_576,
      encoding: "utf8",
    });
    return { code: 0, ...result };
  } catch (cause) {
    const failure = commandFailure.safeParse(cause);
    if (!failure.success) throw cause;
    return {
      code: failure.data.code,
      stdout: failure.data.stdout ?? "",
      stderr: failure.data.stderr ?? String(cause),
    };
  }
};

const installedPackage = z.looseObject({
  name: z.literal(releasePackage),
  version: z.string().min(1),
});

export type ReleaseInstall = Readonly<
  {
    version: string;
    launcher: string;
    node: string;
  } & ({ method: "npm"; prefix: string } | { method: "pnpm" | "bun" })
>;

async function isInstalledLauncher(
  entry: string,
  launcher: string,
): Promise<boolean> {
  try {
    return (await realpath(entry)) === launcher;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

async function probeReleaseManager(
  method: ReleaseInstall["method"],
  install: Pick<ReleaseInstall, "launcher" | "node" | "version">,
  run: CommandRunner,
): Promise<ReleaseInstall | undefined> {
  const result = await run(
    method === "bun" ? ["bun", "pm", "bin", "-g"] : [method, "root", "-g"],
    managerEnvironment(install.node),
  );
  if (result.code !== 0) return undefined;
  const root = result.stdout.trim();
  if (!root.startsWith("/")) return undefined;
  const entry =
    method === "bun"
      ? join(root, "fungi")
      : join(root, releasePackage, "dist/fungi.cjs");
  if (!(await isInstalledLauncher(entry, install.launcher))) return undefined;
  if (method !== "npm") return { ...install, method, launcher: entry };
  const prefix = await run(
    ["npm", "prefix", "-g"],
    managerEnvironment(install.node),
  );
  if (prefix.code !== 0 || !prefix.stdout.trim().startsWith("/"))
    return undefined;
  return {
    ...install,
    method,
    prefix: prefix.stdout.trim(),
    launcher: entry,
  };
}

/** Match manager-owned paths against the actual launcher, never PATH names alone. */
export async function findReleaseInstall(
  env: Readonly<Record<string, string | undefined>> = process.env,
  run: CommandRunner = runCommand,
): Promise<ReleaseInstall> {
  const launcherPath = env.FUNGI_LAUNCHER;
  const node = env.FUNGI_LAUNCHER_NODE;
  const guidance =
    "Could not identify one global npm, pnpm, or bun installation. Reinstall manually with npm install -g @fungi.computer/spore --include=optional. For install.sh, run the install command again.";
  if (launcherPath === undefined || node === undefined)
    throw new Error(guidance);
  const launcher = await realpath(launcherPath).catch((cause: unknown) => {
    throw new Error(guidance, { cause });
  });
  if (
    basename(launcher) !== "fungi.cjs" ||
    basename(dirname(launcher)) !== "dist"
  )
    throw new Error(guidance);
  const packageRoot = dirname(dirname(launcher));
  const { version } = installedPackage.parse(
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  );
  const matches: ReleaseInstall[] = [];
  const methods: readonly ReleaseInstall["method"][] = ["npm", "pnpm", "bun"];
  for (const method of methods) {
    const match = await probeReleaseManager(
      method,
      { launcher, node, version },
      run,
    );
    if (match !== undefined) matches.push(match);
  }
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) throw new Error(guidance);
  return match;
}

/** Hold the file lease through install, verification, and new-build service restart. */
export async function runFungiReleaseUpdate(
  options: Readonly<{
    notify: (message: string) => void;
    run?: CommandRunner;
    install?: ReleaseInstall;
    updates?: string;
    registry?: () => Promise<string>;
  }>,
): Promise<void> {
  const run = options.run ?? runCommand;
  // Reject standalone binaries before creating the update store.
  if (options.install === undefined) await findReleaseInstall(process.env, run);
  const updates = options.updates ?? defaultUpdates();
  await mkdir(updates, { recursive: true, mode: 0o700 });
  const lease = acquireNodeStoreLease(join(updates, "update-owner.sqlite"));
  try {
    await updateRelease(
      options.notify,
      run,
      options.install ?? (await findReleaseInstall(process.env, run)),
      updates,
      options.registry ?? latestFungiVersion,
    );
  } finally {
    lease.release();
  }
}

async function updateRelease(
  notify: (message: string) => void,
  run: CommandRunner,
  install: ReleaseInstall,
  updates: string,
  registry: () => Promise<string>,
): Promise<void> {
  const env = managerEnvironment(install.node);
  const manager = async (args: readonly string[], failure: string) => {
    const result = await run([install.method, ...args], env);
    if (result.code !== 0)
      throw new Error(`${failure}\n${result.stderr.trim()}`.trim());
    return result.stdout;
  };
  notify("Checking the latest Spore release…");
  const latest = releaseVersion.parse(await registry());
  if (latest === install.version) {
    notify(`Spore ${install.version} is the latest release.`);
    await pruneFungiUpdates(updates);
    return;
  }
  const fungi = async (args: readonly string[]) =>
    run([install.node, install.launcher, ...args], env);
  const installVersion = (version: string) => {
    return manager(
      install.method === "npm"
        ? [
            "install",
            "--global",
            "--prefix",
            install.prefix,
            "--include=optional",
            "--no-audit",
            "--no-fund",
            `${releasePackage}@${version}`,
          ]
        : ["add", "--global", `${releasePackage}@${version}`],
      `${install.method} could not install Spore ${version}.`,
    );
  };
  notify(`Installing Spore ${latest} with ${install.method}…`);
  try {
    await installVersion(latest);
    const started = await fungi(["--version"]);
    if (started.code !== 0 || !expectReportedVersion(started.stdout, latest))
      throw new Error(`Spore ${latest} did not start after installing.`);
  } catch (cause) {
    notify(`Restoring Spore ${install.version}…`);
    await installVersion(install.version);
    const restored = await fungi(["--version"]);
    if (
      restored.code !== 0 ||
      reportedVersion(restored.stdout)?.version !== install.version
    )
      throw new Error(
        `Update to ${latest} failed; the previous Spore ${install.version} could not be verified. Reinstall with npm install -g ${releasePackage}@${install.version}.`,
        { cause },
      );
    throw new Error(
      `Update to ${latest} failed; Spore ${install.version} is restored. ${cause instanceof Error ? cause.message : ""}`.trim(),
      { cause },
    );
  }
  const restarted = await fungi(["--internal-service-restart"]);
  if (restarted.code !== 0)
    throw new Error(
      `Fungi ${latest} is installed, but its service could not restart. Run fungi stop, then reopen fungi.\n${restarted.stderr.trim()}`,
    );
  await pruneFungiUpdates(updates);
  notify(`fungi updated ${install.version} → ${latest}.`);
}

const defaultUpdates = () => join(homedir(), ".fungi/updates");

/** Source builds kept besides the active one; older builds are removed. */
const keptSourceBuilds = 1;

/**
 * Remove source builds in ~/.fungi/updates except the one the launcher on
 * PATH uses and the newest previous build (the rollback target).
 */
export async function pruneFungiUpdates(
  updates: string,
  active?: string,
): Promise<readonly string[]> {
  const entries = await readdir(updates, { withFileTypes: true }).catch(
    (cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return [];
      throw cause;
    },
  );
  const builds = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(updates, entry.name);
        return { path, modified: (await stat(path)).mtimeMs };
      }),
  );
  const inUse = (path: string) =>
    active !== undefined && (active === path || active.startsWith(path + sep));
  const removable = builds
    .filter((build) => !inUse(build.path))
    .sort((left, right) => right.modified - left.modified)
    .slice(keptSourceBuilds);
  for (const build of removable)
    await rm(build.path, { recursive: true, force: true });
  return removable.map((build) => build.path);
}

/**
 * Developer path (hidden from help): build a Botanical checkout's integration
 * branch, prove resume against a private copy of the Saved Sessions, then
 * atomically swap the launcher link with automatic rollback.
 */
export async function runFungiSourceUpdate(
  options: Readonly<{
    source: string;
    project: string;
    notify: (message: string) => void;
  }>,
) {
  const updates = defaultUpdates();
  await mkdir(updates, { recursive: true, mode: 0o700 });
  const lease = acquireNodeStoreLease(join(updates, "update-owner.sqlite"));
  try {
    const link = await installedFungiLink();
    const previousTarget = await readlink(link);
    options.notify(
      `Developer update will replace ${link} with a source build. npm will no longer manage this launcher; reinstall with npm install -g ${releasePackage} to return to releases.`,
    );
    options.notify("Building current integration in an isolated checkout…");
    const candidate = await buildIntegrationCandidate(
      resolve(options.source),
      updates,
    );
    options.notify(
      "Proving resume against a private copy of the Saved Sessions…",
    );
    const proof: FungiCandidateProof = await proveFungiCandidate(
      candidate.launcher,
      resolve(options.project),
    );
    await writeFile(
      join(candidate.destination, "update-receipt.json"),
      JSON.stringify(
        {
          sourceSha: candidate.sha,
          cliSha256: candidate.cliHash,
          stateVersions: proof.stateVersions,
          buildLog: candidate.log,
          proof: proof.evidence,
          previousTarget,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    options.notify("Copied-store resume passed. Activating the new launcher…");
    await installedFungiLink();
    await installFungiCandidate(
      link,
      candidate.launcher,
      resolve(options.project),
    );
    await pruneFungiUpdates(updates, candidate.destination);
    options.notify(
      `Fungi updated to ${candidate.sha}. Run fungi resume --last to reopen the TUI.`,
    );
  } finally {
    lease.release();
  }
}
