import type {
  WhistleExecutionInput,
  WhistleExecutionOutcome,
  WhistleRuntime,
  WhistleSnapshot,
} from "@fungi.computer/whistle";

/** Tests choose a public slash alias instead of a host's private namespace. */
export function executeAlias(
  commands: Pick<WhistleRuntime, "snapshot" | "execute">,
  alias: string,
  input: WhistleExecutionInput,
) {
  return commands.execute(slashCommandId(commands, alias), input);
}

function slashCommandId(
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
  return row.commandId;
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
        commandId: string;
        completion: PromiseWithResolvers<WhistleExecutionOutcome>;
      }
    | undefined;
  const commands: WhistleRuntime = {
    ...runtime,
    execute: (commandId, input) => {
      const completion = runtime.execute(commandId, input);
      if (expected?.commandId === commandId) {
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
      const commandId = slashCommandId(commands, alias);
      const completion = Promise.withResolvers<WhistleExecutionOutcome>();
      expected = { commandId, completion };
      return completion.promise;
    },
  };
}
