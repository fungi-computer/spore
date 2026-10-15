import process from "node:process";
import type { OneShotRunOptions } from "./one-shot-run.js";
import type { Cli } from "@fungi.computer/lantern";
import {
  listPrivateTeamComputers,
  startPrivateTeamComputer,
} from "@fungi.computer/local";

export const computersCommandHelp = `Usage: fungi computers [--fungi-mcp <url>]
       fungi computers start <name|id> [--fungi-mcp <url>]

List this Team's Computers with their running, sleeping, queued #N or starting
state. Start a hosted Computer and watch its queue position until it connects.
Uses the project's saved Team endpoint; fungi login --fungi-mcp <url> signs in.
Starts wait up to 30 minutes. Ctrl-C stops waiting; a start already accepted
by the Hub may still finish.
`;
export type ComputersCommandOwners = Readonly<{
  list: typeof listPrivateTeamComputers;
  start: typeof startPrivateTeamComputer;
}>;
type ComputerState = Parameters<
  Parameters<typeof startPrivateTeamComputer>[2]["onState"]
>[0];
function label(state: ComputerState): string {
  return state.state === "queued"
    ? `queued #${String(state.position)}`
    : state.state;
}
export async function runComputersCommand(
  input: {
    name?: string | undefined;
    endpoint: string;
    cli: Pick<Cli, "task" | "step" | "outro" | "cancel">;
    signals?: OneShotRunOptions["signals"];
  },
  owners: ComputersCommandOwners,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  const signals = input.signals ?? process;
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  try {
    if (input.name === undefined) {
      const computers = await input.cli.task("Reading Team Computers", () =>
        owners.list(input.endpoint, { signal: controller.signal }),
      );
      if (computers.length === 0) input.cli.step("This Team has no Computers.");
      for (const computer of computers)
        input.cli.step(
          `${computer.name} (${computer.computerId}): ${label(computer)}`,
        );
      return;
    }
    const name = input.name;
    const computer = await input.cli.task(`Starting ${name}`, (update) =>
      owners.start(input.endpoint, name, {
        signal: controller.signal,
        onState: (state) => {
          update(`${name}: ${label(state)}`);
        },
      }),
    );
    input.cli.outro(`${computer.name}: running`);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    input.cli.cancel(
      "Stopped waiting. A start accepted by the Hub may still finish.",
    );
  } finally {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  }
}
