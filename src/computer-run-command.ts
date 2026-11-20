import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import type {
  ComputerPrices,
  ComputerSize,
  createPrivateTeamComputer,
  deletePrivateTeamComputer,
  readPrivateComputerPrices,
  startPrivateTeamComputer,
} from "@fungi.computer/truffle";

type ComputerState = Parameters<
  Parameters<typeof startPrivateTeamComputer>[2]["onState"]
>[0];

/** A packed folder: tar's output and how tar finished. */
export type FolderArchive = Readonly<{
  stream: Readable;
  finished: Promise<number | "missing">;
  /** Whether .gitignore chose the files (a Git folder) or every file went. */
  gitignore: boolean;
}>;

export type ComputerRunOwners = Readonly<{
  create: typeof createPrivateTeamComputer;
  start: typeof startPrivateTeamComputer;
  remove: typeof deletePrivateTeamComputer;
  prices: typeof readPrivateComputerPrices;
  /** The Team's Computers, to find one whose creation was never confirmed. */
  list: (
    endpoint: string,
  ) => Promise<readonly Readonly<{ computerId: string; name: string }>[]>;
  /** One `fungi computer ssh` session; resolves to ssh's exit code. */
  ssh: (
    input: Readonly<{
      computer: string;
      sshArguments: readonly string[];
      stdin?: Readable | undefined;
      signal: AbortSignal;
    }>,
  ) => Promise<number>;
  archive: (folder: string) => FolderArchive;
  now: () => number;
}>;

/** The Computer's own folder: commands run here and pushed files land here. */
const workspace = "/workspace";
/** Attempts to settle an unconfirmed creation under the Hub's request id. */
const creationAttempts = 3;

/** One argument for the remote shell ssh hands the command to. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A step that failed, named, with its real cause. */
class RunStepError extends Error {}

function creationCause(kind: string): string {
  if (kind === "denied")
    return "you can't create Computers in this Team; ask an owner for access";
  if (kind === "invalid") return "the Hub rejected the size";
  if (kind === "conflict")
    return "the Hub refused it as a conflict with an earlier request";
  return "the Hub could not confirm it was created; run fungi computer list to check";
}

function deletionCause(kind: string): string {
  if (kind === "denied")
    return "only its creator or a Team owner signed in as a person can delete it";
  if (kind === "mismatch")
    return "the Hub did not accept its name as the Computer's";
  if (kind === "unsupported")
    return "this host can't delete a Computer from the terminal";
  return "the delete did not finish";
}

function stateLine(name: string, state: ComputerState): string | undefined {
  if (state.state === "queued")
    return `${name}: waiting for a machine, #${String(state.position)} in line`;
  if (state.state === "starting") return `${name}: starting`;
  return undefined;
}

/** "45 s", "2 min 5 s", "1 h 3 min". */
function durationText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ${String(seconds % 60)} s`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

/** The run's summary: time and size, with a cost estimate when prices exist. */
function summaryLine(
  input: Readonly<{
    name: string;
    size: ComputerSize;
    ms: number;
    prices: ComputerPrices | undefined;
  }>,
): string {
  const ran = `${input.name} (${input.size}) was up for ${durationText(input.ms)}`;
  if (input.prices === undefined) return `${ran}.`;
  const hourlyUsd = input.prices.hourly[input.size] / input.prices.unitsPerUsd;
  const usd = (hourlyUsd * input.ms) / 3_600_000;
  const cost = usd < 0.0001 ? "under $0.0001" : `$${usd.toFixed(4)}`;
  return `${ran}. Estimated cost: ${cost}, at $${String(hourlyUsd)} an hour while awake (an estimate; your bill is metered separately).`;
}

/** Each one stops the run, which still deletes its Computer. */
const runSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * `fungi computer run [--size] [--push <folder>] -- <command>`: create a
 * Computer, push the folder, run the command in it, then always delete the
 * Computer. Resolves to the command's exit code.
 */
export async function runComputerRunCommand(
  input: Readonly<{
    endpoint: string;
    size?: ComputerSize | undefined;
    push?: string | undefined;
    command: readonly string[];
    stderr: Readonly<{ write: (text: string) => void }>;
    signals?:
      | Readonly<{
          on: (
            signal: "SIGINT" | "SIGTERM" | "SIGHUP",
            listener: () => void,
          ) => void;
          off: (
            signal: "SIGINT" | "SIGTERM" | "SIGHUP",
            listener: () => void,
          ) => void;
        }>
      | undefined;
  }>,
  owners: ComputerRunOwners,
): Promise<number> {
  const { stderr } = input;
  if (input.command.length === 0)
    throw new Error(
      "fungi computer run needs a command after --, such as: fungi computer run -- npm test",
    );
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  const signals = input.signals ?? process;
  for (const name of runSignals) signals.on(name, stop);
  const { signal } = controller;
  // Read fresh each time: a signal can arrive during any await.
  const stopped = () => signal.aborted;
  // Asked for at once: a price a host can't give never holds the run up.
  const prices = owners.prices(input.endpoint, { signal }).then(
    (answer) => answer,
    (error: unknown) => {
      stderr.write(
        `No cost estimate: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    },
  );
  let created: Created | undefined;
  let startedAt: number | undefined;
  try {
    const made = await create(input, owners);
    if ("failure" in made) {
      created = made.found;
      throw new RunStepError(made.failure);
    }
    created = made.computer;
    if (stopped()) {
      stderr.write("Stopped.\n");
      return 130;
    }
    stderr.write(
      `Created ${made.computer.name} (${made.computer.computerId}), ${made.computer.size}.\n`,
    );
    const { name, computerId } = created;
    startedAt = owners.now();
    try {
      await owners.start(input.endpoint, computerId, {
        signal,
        onState: (state) => {
          const line = stateLine(name, state);
          if (line !== undefined) stderr.write(`${line}\n`);
        },
      });
    } catch (error) {
      if (stopped()) throw error;
      throw new RunStepError(
        `Couldn't start ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (input.push !== undefined)
      await push(input.push, created, owners, input, signal);
    const command = input.command.map(shellQuote).join(" ");
    stderr.write(`Running ${command} on ${name}\n`);
    let code: number;
    try {
      code = await owners.ssh({
        computer: computerId,
        sshArguments: [`cd ${workspace} && ${command}`],
        signal,
      });
    } catch (error) {
      if (stopped()) throw error;
      throw new RunStepError(
        `Couldn't run the command on ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stopped()) {
      stderr.write("Stopped.\n");
      return 130;
    }
    // ssh answers 255 for its own failures, and passes any other code through.
    if (code === 255)
      stderr.write(
        `ssh exited 255: the connection to ${name} failed, or the command itself exited 255.\n`,
      );
    return code;
  } catch (error) {
    if (!stopped()) throw error;
    stderr.write("Stopped.\n");
    return 130;
  } finally {
    if (created !== undefined)
      await removeComputer(created, input, owners, startedAt, prices);
    for (const name of runSignals) signals.off(name, stop);
  }
}

type Created = Readonly<{
  computerId: string;
  name: string;
  size?: ComputerSize | undefined;
}>;

/**
 * Never aborted: the Hub may make the Computer before a stopped request
 * returns, and only a finished creation says which Computer to delete. Every
 * attempt asks for the same name, so one the Hub never confirmed is found by
 * that name and comes back with the failure, to be deleted.
 */
async function create(
  input: Readonly<{ endpoint: string; size?: ComputerSize | undefined }>,
  owners: ComputerRunOwners,
): Promise<
  | Readonly<{ computer: Readonly<Created & { size: ComputerSize }> }>
  | Readonly<{ failure: string; found?: Created | undefined }>
> {
  const name = `run-${randomBytes(4).toString("hex")}`;
  // Every retry sends the Hub's request id back, so it never makes a second one.
  let requestId: string | undefined;
  let cause = "";
  for (let attempt = 1; attempt <= creationAttempts; attempt += 1) {
    const answer = await owners
      .create(input.endpoint, { name, size: input.size, requestId })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    // A request that failed outright is not retried; the lookup below runs.
    if ("error" in answer) {
      cause = answer.error;
      break;
    }
    const { result } = answer;
    requestId = result.requestId;
    if (result.kind === "created") return { computer: result.computer };
    cause = `${creationCause(result.kind)}.`;
    // A refusal is the Hub's answer: nothing was made.
    if (result.kind !== "uncertain")
      return { failure: `Couldn't create a Computer: ${cause}` };
  }
  const failure = `Couldn't create a Computer: ${cause}`;
  const listed = await owners.list(input.endpoint).then(
    (computers) => ({
      computer: computers.find((computer) => computer.name === name),
    }),
    (error: unknown) => ({
      lookup: error instanceof Error ? error.message : String(error),
    }),
  );
  if ("lookup" in listed)
    return {
      failure: `${failure} Looking for it failed (${listed.lookup}), so if ${name} is listed, delete it with: fungi computer delete ${name}`,
    };
  return { failure, found: listed.computer };
}

async function push(
  folder: string,
  { name, computerId }: Readonly<{ name: string; computerId: string }>,
  owners: ComputerRunOwners,
  input: Readonly<{ stderr: Readonly<{ write: (text: string) => void }> }>,
  signal: AbortSignal,
) {
  const archive = owners.archive(folder);
  input.stderr.write(
    archive.gitignore
      ? `Pushing ${folder} to ${name} (files .gitignore excludes stay behind)\n`
      : `Pushing ${folder} to ${name} (not a Git folder, so every file goes)\n`,
  );
  let code: number;
  try {
    code = await owners.ssh({
      computer: computerId,
      sshArguments: [`mkdir -p ${workspace} && tar -x -f - -C ${workspace}`],
      stdin: archive.stream,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RunStepError(
      `Couldn't push ${folder} to ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const packed = await archive.finished;
  if (signal.aborted) return;
  if (packed === "missing")
    throw new RunStepError(
      `Couldn't push ${folder} to ${name}: tar is not installed on this machine.`,
    );
  if (packed !== 0)
    throw new RunStepError(
      `Couldn't push ${folder} to ${name}: tar exited ${String(packed)} while packing it.`,
    );
  if (code !== 0)
    throw new RunStepError(
      `Couldn't push ${folder} to ${name}: unpacking on the Computer exited ${String(code)}.`,
    );
}

/** Always runs, even after Ctrl-C; a failure names the Computer left behind. */
async function removeComputer(
  created: Created,
  input: Readonly<{
    endpoint: string;
    stderr: Readonly<{ write: (text: string) => void }>;
  }>,
  owners: ComputerRunOwners,
  startedAt: number | undefined,
  prices: Promise<ComputerPrices | undefined>,
) {
  const { stderr } = input;
  const left = `${created.name} (${created.computerId}) is still in your Team and costs money while awake. Delete it with: fungi computer delete ${created.computerId}`;
  stderr.write(`Deleting ${created.name}\n`);
  const failed = await owners.remove(input.endpoint, created, {}).then(
    (removed) =>
      removed.kind === "deleted" ? undefined : deletionCause(removed.kind),
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
  if (failed !== undefined) {
    stderr.write(`Couldn't delete ${created.name}: ${failed}. ${left}\n`);
    return;
  }
  stderr.write(`Deleted ${created.name}.\n`);
  if (startedAt === undefined || created.size === undefined) return;
  stderr.write(
    `${summaryLine({
      name: created.name,
      size: created.size,
      ms: owners.now() - startedAt,
      prices: await prices,
    })}\n`,
  );
}

/**
 * The folder as a tar stream. In a Git folder only the files Git would keep
 * (tracked, plus untracked ones .gitignore does not exclude) are packed, and
 * a submodule goes as an empty folder; anywhere else, every file is.
 */
export function nativeFolderArchive(folder: string): FolderArchive {
  const insideGit = spawnSync(
    "git",
    ["-C", folder, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8" },
  );
  const gitignore =
    insideGit.status === 0 && insideGit.stdout.trim() === "true";
  let names: string[] | undefined;
  if (gitignore) {
    const listed = spawnSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: folder, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    if (listed.status !== 0)
      throw new RunStepError(
        `Couldn't list the files Git keeps in ${folder}: ${listed.stderr.trim()}`,
      );
    // A tracked file deleted from the folder is listed but not packed.
    names = listed.stdout
      .split("\0")
      .filter(
        (name) =>
          name !== "" &&
          lstatSync(join(folder, name), { throwIfNoEntry: false }) !==
            undefined,
      );
  }
  const child = spawn(
    "tar",
    names === undefined
      ? ["-c", "-f", "-", "-C", folder, "."]
      : // Git lists a submodule as one entry; tar must not pack its files.
        ["-c", "-f", "-", "-C", folder, "--no-recursion", "--null", "-T", "-"],
    { stdio: [names === undefined ? "ignore" : "pipe", "pipe", "inherit"] },
  );
  const finished = new Promise<number | "missing">((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve("missing");
      else reject(error);
    });
    child.once("exit", (code, exitSignal) => {
      resolve(code ?? (exitSignal === null ? 1 : 128));
    });
  });
  if (names !== undefined && child.stdin !== null)
    child.stdin.end(names.map((name) => `${name}\0`).join(""));
  if (child.stdout === null) throw new Error("tar has no output stream");
  return { stream: child.stdout, finished, gitignore };
}
