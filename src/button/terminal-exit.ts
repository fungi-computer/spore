import type {
  WhistleRuntime,
  WhistleContribution,
} from "@fungi.computer/whistle";

/** The application-owned lifetime controls shared by all selected Sessions. */
export type TerminalExitActions = Readonly<{
  exit: (() => void) | undefined;
  ctrlC: () => Promise<void>;
}>;

/** Build the stable application command definitions for exit and Ctrl+C. */
export function terminalExitCommandDefinitions(
  actions: TerminalExitActions,
): WhistleContribution["commands"] {
  return [
    {
      id: "ctrl-c",
      title: "Cancel or exit",
      category: "Advanced",
      projections: { bindings: { values: ["ctrl+c"], order: 3 } },
      handler: actions.ctrlC,
    },
    ...(actions.exit === undefined
      ? []
      : [
          {
            id: "exit",
            title: "Exit the terminal",
            category: "Advanced",
            projections: { slash: { aliases: ["exit"], order: 3 } },
            handler: actions.exit,
          },
        ]),
  ];
}

/** Contribute the application lifetime controls as one replaceable lease. */
export function contributeTerminalExitCommands(
  commands: Pick<WhistleRuntime, "contribute">,
  actions: TerminalExitActions,
) {
  return commands.contribute({
    sourceId: "tui-frame",
    namespace: "tui",
    commands: terminalExitCommandDefinitions(actions),
  });
}
