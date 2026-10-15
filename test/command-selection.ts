import type {
  WhistleExecutionInput,
  WhistleRuntime,
} from "@fungi.computer/whistle";

/** Tests choose a public slash alias instead of a host's private namespace. */
export function executeAlias(
  commands: Pick<WhistleRuntime, "snapshot" | "execute">,
  alias: string,
  input: WhistleExecutionInput,
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
  return commands.execute(row.commandId, input);
}
