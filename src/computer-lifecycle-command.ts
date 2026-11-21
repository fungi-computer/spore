import process from "node:process";
import { z } from "zod";
import type { Cli } from "@fungi.computer/lantern";
import type {
  ComputerSize,
  createPrivateTeamComputer,
  deletePrivateTeamComputer,
  describePrivateTeamComputer,
  listPrivateTeamComputers,
  startPrivateTeamComputer,
  stopPrivateTeamComputer,
} from "@fungi.computer/truffle";

export type ComputerLifecycleOwners = Readonly<{
  list: typeof listPrivateTeamComputers;
  describe: typeof describePrivateTeamComputer;
  create: typeof createPrivateTeamComputer;
  start: typeof startPrivateTeamComputer;
  stop: typeof stopPrivateTeamComputer;
  remove: typeof deletePrivateTeamComputer;
}>;

type ComputerState = Parameters<
  Parameters<typeof startPrivateTeamComputer>[2]["onState"]
>[0];
type Row = Readonly<{ computerId: string; name: string }> & ComputerState;

/** One plain phrase for a runtime state. */
function label(state: ComputerState): string {
  if (state.state === "queued") return `queued #${String(state.position)}`;
  if (state.state === "start_failed")
    return state.reason === undefined
      ? "couldn't start: the Hub gave no reason"
      : `couldn't start: ${state.reason}`;
  return state.state;
}

const rowLine = (row: Row) => `${row.name} (${row.computerId}): ${label(row)}`;

/** The Hub's refusal of a creation, in plain words that name the cause. */
function creationRefusal(kind: string, name: string | undefined): string {
  if (kind === "denied")
    return "You can't create Computers in this Team. Ask an owner for access.";
  if (kind === "conflict")
    return name === undefined
      ? "The Hub refused this creation as a conflict with an earlier request."
      : `A Computer named ${name} already exists in this Team. Choose another name.`;
  if (kind === "invalid")
    return "The Hub rejected that name or size. Names are 1 to 256 characters; sizes are small, default or large.";
  return "The Hub could not confirm the Computer was created. Run fungi computer list before trying again.";
}

/** The Hub's refusal of a stop, in plain words that name the cause. */
function stopRefusal(kind: string, name: string): string {
  if (kind === "denied")
    return `You can't stop ${name}. Only its creator or a Team owner can.`;
  if (kind === "busy")
    return `${name} is starting or finishing an operation. Try again in a moment.`;
  return `The Hub could not confirm ${name} stopped. Run fungi computer info ${name}, then try again.`;
}

/** The Hub's refusal of a delete, in plain words that name the cause. */
function deletionRefusal(kind: string, name: string): string {
  if (kind === "denied")
    return `You can't delete ${name}. Only its creator or a Team owner can.`;
  if (kind === "mismatch")
    return `The Hub did not accept ${name} as the Computer's name. Run fungi computer list and try again.`;
  if (kind === "unsupported")
    return "This host can't delete a Computer from the terminal. Delete it from its settings.";
  return `Deleting ${name} did not finish. Run the same command again to finish it.`;
}

/** Attempts to settle an unconfirmed creation under the Hub's request id. */
const creationAttempts = 3;

export async function runComputerLifecycleCommand(
  input: {
    action: "list" | "info" | "new" | "start" | "stop" | "delete";
    computer?: string | undefined;
    size?: ComputerSize | undefined;
    endpoint: string;
    json: boolean;
    /** Skip the delete question. */
    yes: boolean;
    /** Asks a yes or no question on the terminal; absent without one. */
    confirm?: ((question: string) => Promise<boolean>) | undefined;
    stdout: Readonly<{ write: (text: string) => void }>;
    stderr: Readonly<{ write: (text: string) => void }>;
    cli: Pick<Cli, "task" | "step" | "outro" | "cancel">;
    signals?:
      | Readonly<{
          on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
          off: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
        }>
      | undefined;
  },
  owners: ComputerLifecycleOwners,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  const signals = input.signals ?? process;
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  const options = { signal: controller.signal };
  const { stdout, json } = input;
  try {
    if (input.action === "list") {
      const rows = await owners.list(input.endpoint, options);
      if (json) stdout.write(`${JSON.stringify({ computers: rows })}\n`);
      else if (rows.length === 0) stdout.write("This Team has no Computers.\n");
      else for (const row of rows) stdout.write(`${rowLine(row)}\n`);
      return;
    }
    if (input.action === "info") {
      const row = await owners.describe(
        input.endpoint,
        requireComputer(input),
        options,
      );
      if (json) stdout.write(`${JSON.stringify({ computer: row })}\n`);
      else {
        const sized = z.object({ size: z.string() }).safeParse(row);
        const size = sized.success ? `, ${sized.data.size}` : "";
        stdout.write(`${rowLine(row)}${size}\n`);
      }
      return;
    }
    if (input.action === "stop") {
      const stopped = await owners.stop(
        input.endpoint,
        requireComputer(input),
        options,
      );
      if (stopped.kind !== "stopped")
        throw new Error(stopRefusal(stopped.kind, stopped.name));
      if (json)
        stdout.write(
          `${JSON.stringify({ computer: { computerId: stopped.computerId, name: stopped.name }, state: "sleeping" })}\n`,
        );
      else
        stdout.write(
          `Stopped ${stopped.name}. Its files are kept; fungi computer start ${stopped.name} brings it back.\n`,
        );
      return;
    }
    if (input.action === "delete") {
      const target = await owners.describe(
        input.endpoint,
        requireComputer(input),
        options,
      );
      if (!input.yes) {
        if (json) throw new Error("fungi computer delete --json needs --yes");
        if (input.confirm === undefined)
          throw new Error(
            "fungi computer delete needs --yes without a terminal",
          );
        if (
          !(await input.confirm(
            `Delete ${target.name} (${target.computerId}) and erase its files? This cannot be undone. [y/N] `,
          ))
        ) {
          stdout.write("Not deleted.\n");
          return;
        }
      }
      // By the id the person confirmed, with the name they were shown: a
      // Computer renamed or replaced meanwhile is refused, never deleted instead.
      const removed = await owners.remove(
        input.endpoint,
        { computerId: target.computerId, name: target.name },
        options,
      );
      if (removed.kind !== "deleted")
        throw new Error(deletionRefusal(removed.kind, removed.name));
      if (json)
        stdout.write(
          `${JSON.stringify({ deleted: { computerId: removed.computerId, name: removed.name } })}\n`,
        );
      else stdout.write(`Deleted ${removed.name} and erased its files.\n`);
      return;
    }
    if (input.action === "start") {
      const name = requireComputer(input);
      // --json keeps stdout to the one document; progress goes to stderr.
      const started = json
        ? await owners.start(input.endpoint, name, {
            ...options,
            onState: (state) => {
              input.stderr.write(`${name}: ${label(state)}\n`);
            },
          })
        : await input.cli.task(`Starting ${name}`, (update) =>
            owners.start(input.endpoint, name, {
              ...options,
              onState: (state) => {
                update(`${name}: ${label(state)}`);
              },
            }),
          );
      if (json)
        stdout.write(
          `${JSON.stringify({ computer: started, state: "running" })}\n`,
        );
      else input.cli.outro(`${started.name}: running`);
      return;
    }
    // The Hub names the creation; every retry sends that id back, so a retry
    // replays the same creation and never makes a second Computer.
    let requestId: string | undefined;
    for (let attempt = 1; ; attempt += 1) {
      const result = await owners.create(
        input.endpoint,
        { name: input.computer, size: input.size, requestId },
        options,
      );
      requestId = result.requestId;
      if (result.kind === "created") {
        if (json)
          stdout.write(`${JSON.stringify({ computer: result.computer })}\n`);
        else
          stdout.write(
            `Created ${result.computer.name} (${result.computer.computerId}), ${result.computer.size}. Start it with: fungi computer start ${result.computer.name}\n`,
          );
        return;
      }
      if (result.kind !== "uncertain" || attempt === creationAttempts)
        throw new Error(creationRefusal(result.kind, input.computer));
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    input.cli.cancel(
      input.action === "start"
        ? "Stopped waiting. A start accepted by the Hub may still finish."
        : "Stopped.",
    );
  } finally {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  }
}

function requireComputer(input: {
  action: string;
  computer?: string | undefined;
}) {
  if (input.computer === undefined)
    throw new Error(`fungi computer ${input.action} requires a Computer`);
  return input.computer;
}
