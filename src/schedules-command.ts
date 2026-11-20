import type {
  LocalSchedulePage,
  PrivateLocalServiceManager,
} from "@fungi.computer/truffle/service";
import { displayText } from "./shell/display-text.js";

export const schedulesCommandHelp = `Usage: fungi schedules list [-C dir]
       fungi schedules pause <agent-id> <ref> [-C dir]
       fungi schedules delete <agent-id> <ref> [--yes] [-C dir]

List every retained schedule of this folder's Agents, including Agents you have
not opened, joined or that are archived, and pause or delete one. A ref is the
one fungi schedules list prints: almanac:<id> or loop:<conversation>/<loop>.
Pause stops future occurrences; its conversation can resume it. Delete cancels
future occurrences and asks first (--yes skips the question); work already
accepted and its history stay. An Agent whose schedules could not be read is
named, never shown as having none. There is no resume here.
`;

type Row = LocalSchedulePage["items"][number];
type Continuation = NonNullable<LocalSchedulePage["next"]>;

export type SchedulesCommandInput = Readonly<{
  action: "list" | "pause" | "delete";
  agentId?: string | undefined;
  ref?: string | undefined;
  /** `delete`: skip the question. */
  yes: boolean;
  /** Asks a yes or no question on the terminal; absent without one. */
  confirm?: ((question: string) => Promise<boolean>) | undefined;
  invocationRoot: string;
  manager: Pick<PrivateLocalServiceManager, "schedules">;
  stdout: Readonly<{ write: (text: string) => void }>;
}>;

/** The most pages one command reads: far more than a folder keeps, and bounded. */
const maximumPages = 100;

/** The ref the list prints and a person types back; never parsed, only compared. */
function refOf(row: Row): string {
  return row.kind === "almanac"
    ? `almanac:${row.schedule.id}`
    : `loop:${row.schedule.sessionId}/${row.schedule.loopId}`;
}

function cadence(row: Row): string {
  const { cron } = row.schedule;
  if (cron === null)
    return row.kind === "loop" && row.schedule.mode === "self_paced"
      ? "self-paced"
      : "once";
  return `${cron.expression} ${cron.timeZone}`;
}

const nextAt = (row: Row): string =>
  row.schedule.nextDueAt === null
    ? "next none"
    : `next ${new Date(row.schedule.nextDueAt).toISOString()}`;

/** Every page, in order. A page's unavailable owners are collected, never dropped. */
async function readAll(
  manager: SchedulesCommandInput["manager"],
  invocationRoot: string,
) {
  const schedules = manager.schedules(invocationRoot);
  const rows: Row[] = [];
  const unavailable: string[] = [];
  let after: Continuation | undefined;
  for (let pageNumber = 0; ; pageNumber += 1) {
    if (pageNumber === maximumPages)
      throw new Error(
        `Couldn't read every schedule in ${invocationRoot}: there are more than this command will list.`,
      );
    const page = await schedules.list(after === undefined ? {} : { after });
    rows.push(...page.items);
    for (const owner of page.unavailable) unavailable.push(owner.agentId);
    if (page.next === null) return { schedules, rows, unavailable };
    after = page.next;
  }
}

function unavailableError(root: string, agents: readonly string[]): Error {
  return new Error(
    `Couldn't read every schedule in ${root}: ${[...new Set(agents)].join(", ")} unavailable (its Agent could not be opened). Try again, or stop the Agent's running command first.`,
  );
}

function table(rows: readonly Row[]): string[] {
  const cells = rows.map((row) => [
    row.agentId,
    refOf(row),
    row.schedule.state,
    cadence(row),
    nextAt(row),
    displayText(row.schedule.prompt).slice(0, 60),
  ]);
  const widths = [0, 1, 2, 3, 4].map((column) =>
    Math.max(...cells.map((cell) => (cell[column] ?? "").length)),
  );
  return cells.map((cell) =>
    cell
      .map((value, column) =>
        column === 5 ? value : value.padEnd((widths[column] ?? 0) + 2),
      )
      .join(""),
  );
}

/** `fungi schedules`: the private Local schedules of this folder's Agents, for the person at this machine. */
export async function runSchedulesCommand(
  input: SchedulesCommandInput,
): Promise<void> {
  const { action, invocationRoot, manager, stdout } = input;
  const { schedules, rows, unavailable } = await readAll(
    manager,
    invocationRoot,
  );
  if (action === "list") {
    if (rows.length === 0 && unavailable.length === 0) {
      stdout.write(`No schedules in ${invocationRoot}.\n`);
      return;
    }
    for (const line of table(rows)) stdout.write(`${line}\n`);
    if (unavailable.length > 0)
      throw unavailableError(invocationRoot, unavailable);
    return;
  }
  const { agentId, ref } = input;
  if (agentId === undefined || ref === undefined)
    throw new Error(schedulesCommandHelp);
  const verb = action === "pause" ? "pause" : "delete";
  // The exact listed identity: a Loop is addressed by its own id, never by a
  // later replacement, so the target is built from the listed row.
  const row = rows.find(
    (candidate) => candidate.agentId === agentId && refOf(candidate) === ref,
  );
  if (row === undefined) {
    if (unavailable.includes(agentId))
      throw unavailableError(invocationRoot, [agentId]);
    throw new Error(
      `Couldn't ${verb} ${ref}: ${agentId} has no such schedule in ${invocationRoot}. Run fungi schedules list.`,
    );
  }
  if (action === "delete" && !input.yes) {
    if (input.confirm === undefined)
      throw new Error("fungi schedules delete needs --yes without a terminal");
    if (
      !(await input.confirm(
        `Delete ${ref} (${displayText(row.schedule.prompt).slice(0, 40)})? Future occurrences are cancelled. [y/N] `,
      ))
    ) {
      stdout.write("Not deleted.\n");
      return;
    }
  }
  const target =
    row.kind === "almanac"
      ? {
          kind: "almanac" as const,
          agentId: row.agentId,
          scheduleId: row.schedule.id,
        }
      : {
          kind: "loop" as const,
          agentId: row.agentId,
          sessionId: row.schedule.sessionId,
          loopId: row.schedule.loopId,
        };
  try {
    await (action === "pause"
      ? schedules.pause(target)
      : schedules.delete(target));
  } catch (cause) {
    throw new Error(
      `Couldn't ${verb} ${ref}: ${(cause instanceof Error ? cause.message : "the Agent refused it").replace(/\.+$/u, "")}.`,
      { cause },
    );
  }
  stdout.write(
    action === "pause"
      ? `Paused ${ref}. Future occurrences stop; its conversation can resume it. Work already accepted stays.\n`
      : `Deleted ${ref}. Future occurrences are cancelled; work already accepted and its history stay.\n`,
  );
}
