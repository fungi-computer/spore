import {
  readlink,
  realpath,
  rename,
  symlink,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import process from "node:process";

async function command(launcher: string, args: readonly string[], log: string) {
  const child = Bun.spawn([launcher, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  await writeFile(log, stderr, { flag: "a", mode: 0o600 });
  if (code !== 0)
    throw new Error(
      `Fungi could not stop or reopen its Local service; inspect ${log}`,
    );
}

/** Replace only the user's launcher link, on the same filesystem. */
async function replaceLink(link: string, target: string) {
  const directory = await mkdtemp(`${link}.update-`);
  const temporary = join(directory, "launcher");
  try {
    await symlink(target, temporary);
    await rename(temporary, link);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The build and copied-store proof must finish before this activation begins. */
export async function installFungiCandidate(
  link: string,
  candidate: string,
  project: string,
): Promise<void> {
  const oldTarget = await readlink(link);
  const oldLauncher = resolve(dirname(link), oldTarget);
  const log = resolve(dirname(candidate), "activation.log");
  await command(oldLauncher, ["stop"], log);
  let swapped = false;
  try {
    await replaceLink(link, candidate);
    swapped = true;
    await command(
      candidate,
      ["sessions", "status", "--last", "--json", "-C", project],
      log,
    );
  } catch (activationFailure: unknown) {
    // Stop only the failed candidate service before restoring the old launcher.
    const stopFailure = swapped
      ? await command(candidate, ["stop"], log).catch(
          (cause: unknown) =>
            new Error("The candidate service could not be stopped", { cause }),
        )
      : undefined;
    if (swapped) {
      await replaceLink(link, oldTarget);
    }
    try {
      await command(
        oldLauncher,
        ["sessions", "status", "--last", "--json", "-C", project],
        log,
      );
    } catch (reopenFailure: unknown) {
      throw new AggregateError(
        stopFailure instanceof Error
          ? [activationFailure, stopFailure, reopenFailure]
          : [activationFailure, reopenFailure],
        `Update activation failed. ${stopFailure instanceof Error ? `${stopFailure.message}. ` : ""}The previous launcher was restored, but its service could not reopen. Inspect ${log}; run fungi resume --last; keep the Saved Session files.`,
        { cause: reopenFailure },
      );
    }
    if (stopFailure instanceof Error)
      throw new AggregateError(
        [activationFailure, stopFailure],
        `Update activation failed: the candidate service could not be stopped. Restored the previous launcher and Local service. Inspect ${log}; run fungi resume --last.`,
        { cause: activationFailure },
      );
    throw new Error(
      `Update activation failed; restored the previous launcher and Local service. Inspect ${log}; run fungi resume --last.`,
      { cause: activationFailure },
    );
  }
}

/** Find the actual PATH entry, rather than assuming npm's global prefix. */
export async function installedFungiLink(): Promise<string> {
  const child = Bun.spawn(["which", "fungi"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(child.stdout).text();
  if ((await child.exited) !== 0 || text.trim() === "")
    throw new Error("Fungi launcher is not on PATH");
  const link = text.trim();
  await readlink(link);
  if (process.env.FUNGI_LAUNCHER === undefined)
    throw new Error("Run fungi update through the installed bundled launcher");
  if ((await realpath(link)) !== (await realpath(process.env.FUNGI_LAUNCHER)))
    throw new Error(
      "The launcher on PATH changed; run fungi update through that installed launcher",
    );
  return link;
}
