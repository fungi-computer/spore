import type {
  WhistleRuntime,
  WhistleCommand,
  WhistleExecutionOrigin,
} from "@fungi.computer/whistle";
import type { ParakeetReconnectOutcome } from "@fungi.computer/parakeet/headless";
import { z } from "../../button/index.js";
import { WhistleActionError } from "@fungi.computer/whistle";

const stopArguments = z.strictObject({ scope: z.literal("all") });

export type TerminalActions = {
  canCancel: boolean;
  canRetry: boolean;
  canContinue: boolean;
  stopAll?: (() => Promise<void>) | undefined;
  cancel: (origin: WhistleExecutionOrigin) => Promise<void>;
  reconnect: () => Promise<ParakeetReconnectOutcome>;
  retry: () => boolean;
  continue: () => Promise<boolean>;
  details: () => void;
  toolGroup: () => void;
};

/** Declarations for the mounted conversation's current controls. */
export function terminalCommandDefinitions(
  actions: Readonly<TerminalActions>,
): readonly WhistleCommand<never>[] {
  return [
    {
      id: "stop",
      title: "Stop this Agent and its helpers",
      category: "Conversation",
      projections: {
        slash: {
          aliases: ["stop"],
          arguments: {
            hint: "all",
            words: [{ word: "all", arguments: { scope: "all" } }],
          },
        },
      },
      availability: () =>
        actions.stopAll === undefined
          ? {
              status: "unavailable",
              reason: "This connection cannot stop an Agent tree.",
            }
          : { status: "available" },
      handler: async ({ arguments: args }) => {
        if (!stopArguments.safeParse(args).success)
          throw new Error("Use /stop all");
        if (actions.stopAll === undefined)
          throw new Error("Stop all is unavailable");
        await actions.stopAll();
      },
    },
    {
      id: "escape",
      title: "Dismiss or stop",
      category: "Advanced",
      projections: { bindings: { values: ["escape"], order: 1 } },
      handler: () => actions.cancel("keyboard"),
    },
    {
      id: "cancel",
      title: "Stop current turn (queue drains)",
      category: "Conversation",
      projections: {
        slash: { aliases: ["cancel"], order: -4 },
      },
      availability: () =>
        actions.canCancel
          ? { status: "available" }
          : {
              status: "unavailable",
              reason: "There is no running turn to stop.",
            },
      handler: ({ origin }) => actions.cancel(origin),
    },
    {
      id: "reconnect",
      title: "Reconnect history",
      category: "Advanced",
      projections: { slash: { aliases: ["reconnect"], order: 2 } },
      availability: () => ({ status: "available" }),
      handler: async ({ interaction }) => {
        const outcome = await actions.reconnect();
        if (outcome.kind === "failed")
          throw new WhistleActionError(
            "reconnect_failed",
            `Reconnect failed: ${outcome.cause}. Check the connection, then try /reconnect again.`,
          );
        // A reconnect that worked is visible in the history: no echo.
        if (outcome.kind === "nothing_to_reconnect")
          interaction?.notify({
            type: "info",
            message:
              outcome.state === "connected"
                ? "Session history is already connected."
                : "Session history is connecting; wait for it to finish.",
          });
        return outcome;
      },
    },
    {
      id: "retry",
      title: "Run it again",
      category: "Conversation",
      projections: { slash: { aliases: ["retry"], order: -3 } },
      availability: () =>
        actions.canRetry
          ? { status: "available" }
          : {
              status: "unavailable",
              reason: "There is no failed instruction to retry.",
            },
      handler: ({ interaction }) => {
        const started = actions.retry();
        if (!started)
          interaction?.notify({
            type: "info",
            message:
              "There is no failed instruction to retry; type a new instruction.",
          });
        return started;
      },
    },
    {
      id: "continue",
      title: "Pick up where it stopped",
      category: "Conversation",
      projections: { slash: { aliases: ["continue"], order: -2 } },
      availability: () =>
        actions.canContinue
          ? { status: "available" }
          : {
              status: "unavailable",
              reason: "There is no stopped run to continue.",
            },
      handler: async ({ interaction }) => {
        const started = await actions.continue();
        if (!started)
          interaction?.notify({
            type: "info",
            message:
              "There is no stopped run to continue; type a new instruction.",
          });
        return started;
      },
    },
    {
      id: "details",
      title: "Toggle details",
      category: "Advanced",
      projections: {
        bindings: { values: ["ctrl+o"], order: 2 },
        slash: { aliases: ["details"], order: 2 },
      },
      handler: actions.details,
    },
    {
      id: "tool-group",
      title: "Toggle the focused tool group or Agent message",
      category: "Conversation",
      projections: { bindings: { values: ["ctrl+g"], order: 2 } },
      handler: actions.toolGroup,
    },
  ];
}

/** Contribute the actions owned by one mounted terminal frame. */
export function contributeTerminalCommands(
  commands: Pick<WhistleRuntime, "contribute">,
  actions: Readonly<TerminalActions>,
) {
  return commands.contribute({
    sourceId: "tui-frame",
    namespace: "tui",
    commands: terminalCommandDefinitions(actions),
  });
}
