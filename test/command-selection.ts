import {
  sameWhistleCommand,
  type WhistleCommandKey,
  type WhistleExecutionInput,
  type WhistleExecutionOutcome,
  type WhistleRuntime,
  type WhistleSnapshot,
} from "@fungi.computer/whistle";

/** Tests choose a public slash alias instead of a host's private namespace. */
export function executeAlias(
  commands: Pick<WhistleRuntime, "snapshot" | "execute">,
  alias: string,
  input: WhistleExecutionInput,
) {
  return commands.execute(slashCommand(commands, alias), input);
}

function slashCommand(
  commands: Pick<WhistleRuntime, "snapshot">,
  alias: string,
) {
  const matches = commands
    .snapshot()
    .slash.filter((row) => row.alias === alias);
  if (matches.length !== 1)
    throw new Error(
      `Expected one admitted /${alias} command, received ${String(matches.length)}`,
    );
  const row = matches[0];
  if (row === undefined) throw new Error(`/${alias} command absent`);
  return row.command;
}

/** Observe graph admission at its owner, not through renderer drain passes. */
export function waitForCommandGraph(
  commands: Pick<WhistleRuntime, "snapshot" | "subscribe">,
  ready: (snapshot: WhistleSnapshot) => boolean,
): Promise<void> {
  if (ready(commands.snapshot())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = commands.subscribe(() => {
      if (!ready(commands.snapshot())) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Keep native slash input while observing its real execution promise. */
export function observeCommandExecutions(runtime: WhistleRuntime) {
  let expected:
    | {
        command: WhistleCommandKey;
        completion: PromiseWithResolvers<WhistleExecutionOutcome>;
      }
    | undefined;
  const commands: WhistleRuntime = {
    ...runtime,
    execute: (command, input) => {
      const completion = runtime.execute(command, input);
      if (
        expected !== undefined &&
        sameWhistleCommand(expected.command, command)
      ) {
        const waiting = expected;
        expected = undefined;
        waiting.completion.resolve(completion);
      }
      return completion;
    },
  };
  return {
    commands,
    nextExecution: (alias: string) => {
      if (expected !== undefined)
        throw new Error("A command execution is already being observed");
      const command = slashCommand(commands, alias);
      const completion = Promise.withResolvers<WhistleExecutionOutcome>();
      expected = { command, completion };
      return completion.promise;
    },
  };
}
