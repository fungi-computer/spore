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
import { z } from "zod";
import { acquireNodeStoreLease } from "@fungi.computer/shiitake/node";
import { buildIntegrationCandidate } from "./update-build.js";
import {
  proveFungiCandidate,
  type FungiCandidateProof,
} from "./update-proof.js";
import { installFungiCandidate, installedFungiLink } from "./update-install.js";

/**
 * Spore is the install/update/rollback layer behind `fungi`. A released
 * fungi updates from npm, the channel it is published to: npm resolves the
 * `latest` dist-tag, verifies the tarball's registry integrity, and owns the
 * global install. fungi only stops its service, checks the new version starts,
 * and puts the previous release back when it does not.
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

const runCommand: CommandRunner = async (command, env) => {
  const child = Bun.spawn([...command], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

const installedPackage = z.looseObject({
  name: z.literal(releasePackage),
  version: z.string().min(1),
});

export type ReleaseInstall = Readonly<{
  /** The npm global prefix that owns this install. */
  prefix: string;
  version: string;
  launcher: string;
  node: string;
}>;

/** Find the npm global install that launched this process, or explain why not. */
export async function findReleaseInstall(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ReleaseInstall> {
  const launcherPath = env.FUNGI_LAUNCHER;
  const node = env.FUNGI_LAUNCHER_NODE;
  if (
    launcherPath === undefined ||
    node === undefined ||
    basename(launcherPath) !== "fungi.cjs" ||
    basename(dirname(launcherPath)) !== "dist"
  )
    throw new Error(
      "fungi update updates an npm install of @fungi.computer/spore. If you installed fungi with install.sh, run the install command again.",
    );
  const launcher = await realpath(launcherPath);
  const packageRoot = dirname(dirname(launcher));
  const scope = dirname(packageRoot);
  const modules = dirname(scope);
  const lib = dirname(modules);
  if (
    basename(packageRoot) !== "cli" ||
    basename(scope) !== "@fungi.computer" ||
    basename(modules) !== "node_modules" ||
    (basename(lib) !== "lib" && process.platform !== "win32")
  )
    throw new Error(
      `This fungi runs from ${packageRoot}, not a global npm install. Reinstall with npm install -g ${releasePackage}.`,
    );
  const { version } = installedPackage.parse(
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  );
  return { prefix: dirname(lib), version, launcher, node };
}

const npmVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);

/** Update the npm install to the `latest` release, restoring the old one on failure. */
export async function runFungiReleaseUpdate(
  options: Readonly<{
    notify: (message: string) => void;
    run?: CommandRunner;
    install?: ReleaseInstall;
    updates?: string;
  }>,
): Promise<void> {
  const run = options.run ?? runCommand;
  // Reject standalone binaries before creating the update store.
  if (options.install === undefined) await findReleaseInstall();
  const updates = options.updates ?? defaultUpdates();
  await mkdir(updates, { recursive: true, mode: 0o700 });
  const lease = acquireNodeStoreLease(join(updates, "update-owner.sqlite"));
  try {
    await updateRelease(
      options.notify,
      run,
      options.install ?? (await findReleaseInstall()),
      updates,
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
): Promise<void> {
  // npm beside the Node that runs fungi, so both agree on the global prefix.
  const env = {
    PATH: `${dirname(install.node)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  };
  const npm = async (args: readonly string[], failure: string) => {
    const result = await run(["npm", ...args], env);
    if (result.code !== 0)
      throw new Error(`${failure}\n${result.stderr.trim()}`.trim());
    return result.stdout;
  };
  notify("Checking the latest fungi release…");
  const latest = npmVersion.parse(
    JSON.parse(
      await npm(
        ["view", `${releasePackage}@latest`, "version", "--json"],
        "Could not read the latest fungi release from npm.",
      ),
    ),
  );
  if (latest === install.version) {
    notify(`fungi ${install.version} is the latest release.`);
    await pruneFungiUpdates(updates);
    return;
  }
  const fungi = async (args: readonly string[]) =>
    run([install.node, install.launcher, ...args], env);
  const stopped = await fungi(["stop"]);
  if (stopped.code !== 0)
    throw new Error(
      `fungi could not stop its background service; nothing was changed.\n${stopped.stderr.trim()}`,
    );
  const installVersion = (version: string) =>
    npm(
      [
        "install",
        "--global",
        "--prefix",
        install.prefix,
        "--include=optional",
        "--no-audit",
        "--no-fund",
        `${releasePackage}@${version}`,
      ],
      `npm could not install fungi ${version}.`,
    );
  notify(`Installing fungi ${latest} with npm…`);
  try {
    await installVersion(latest);
    const started = await fungi(["--version"]);
    if (started.code !== 0 || started.stdout.trim() !== `fungi ${latest}`)
      throw new Error(`fungi ${latest} did not start after installing.`);
  } catch (cause) {
    notify(`Restoring fungi ${install.version}…`);
    await installVersion(install.version);
    const restored = await fungi(["--version"]);
    if (
      restored.code !== 0 ||
      restored.stdout.trim() !== `fungi ${install.version}`
    )
      throw new Error(
        `Update to ${latest} failed; the previous fungi ${install.version} could not be verified. Reinstall with npm install -g ${releasePackage}@${install.version}.`,
        { cause },
      );
    throw new Error(
      `Update to ${latest} failed; fungi ${install.version} is restored. ${cause instanceof Error ? cause.message : ""}`.trim(),
      { cause },
    );
  }
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
