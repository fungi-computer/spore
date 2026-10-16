import { createElement } from "react";
import {
  PaneProvider,
  paneCommandRuntime,
  defineIdFamily,
  z,
  conversationNavigation,
  type PaneKindEntry,
} from "../../button/index.js";
import { TuiFrameContent } from "./frame.js";
import { contributeTerminalExitCommands } from "../../button/index.js";

const identifier = z.string().min(1).max(256);
const displayTitle = z.string().max(4096).optional();
const targets = z.union([
  z.object({
    kind: z.literal("conversation"),
    agentId: identifier,
    sessionId: identifier,
    title: displayTitle,
  }),
  z.object({
    kind: z.literal("conversation"),
    agentId: identifier,
    sessionId: z.null(),
    createRequestId: identifier,
    title: displayTitle,
  }),
]);
const sessionCreateRequests = defineIdFamily({
  family: "tui-session-create-request",
  version: 1,
  kinds: { request: { prefix: "request" } },
});

export const conversationPane: PaneKindEntry = {
  kind: "conversation",
  instantiate: (input) => {
    const parsed = targets.safeParse(input);
    if (!parsed.success) return undefined;
    const target = parsed.data;
    const label = target.title?.trim();
    const title = label === undefined || label.length === 0 ? undefined : label;
    return {
      key:
        target.sessionId === null
          ? JSON.stringify([target.agentId, null, target.createRequestId])
          : JSON.stringify([target.agentId, target.sessionId]),
      title: title ?? "New conversation",
      render: async (kit) => {
        // One key per `/new` intent: a failed attempt keeps it for the retry.
        let createRequestId: string | undefined;
        const session = await kit.sessions.acquire(target, kit.signal);
        if (kit.signal.aborted) return null;
        const details = kit.sessions.describe?.(session);
        const resume = details?.resume;
        const forked = details?.forked;
        const observationUnavailable = details?.observationUnavailable;
        const name = details?.agentName?.trim();
        const agentName =
          name === undefined || name.length === 0 ? "Agent" : name;
        const untitled = `${agentName} · New conversation`;
        kit.setTitle(title ?? untitled);
        // The pane's metadata follows the owner's title: the user's, else the
        // first prompt's. A bounded owner read restores it after /name clears.
        const ownerTitle = async () => {
          const read = await details?.sessionTitle?.(kit.signal);
          const shown = read?.trim();
          if (!kit.signal.aborted)
            kit.setTitle(
              shown === undefined || shown.length === 0 ? untitled : shown,
            );
        };
        const commands = paneCommandRuntime(kit);
        const lease = contributeTerminalExitCommands(commands, {
          exit: undefined,
          ctrlC: () => {
            kit.exit();
            return Promise.resolve();
          },
        });
        kit.onDispose(lease.dispose);
        return createElement(
          PaneProvider,
          { kit },
          createElement(TuiFrameContent, {
            session,
            commands,
            applicationCommands: { lease, exit: kit.exit },
            onExit: kit.exit,
            initialTheme: details?.themeName,
            onThemeConfirm: details?.saveTheme,
            themeError: details?.themeError,
            clients: details?.clients,
            interactionStore: details?.interactions,
            modelSource: details?.models,
            folder: details?.folder,
            onTitled: async (saved: string | null) => {
              if (saved === null) await ownerTitle();
              else kit.setTitle(saved);
            },
            reloadSources: details?.reload,
            initialCommandError: details?.initialError,
            initialCommandNotice: details?.initialNotice,
            onObservationUnavailable:
              observationUnavailable === undefined
                ? undefined
                : () => observationUnavailable(kit.paneId),
            inputHandoff: details?.inputHandoff,
            onResume:
              resume === undefined ? undefined : () => resume(kit.paneId),
            onNew: async () => {
              createRequestId ??= sessionCreateRequests.request.generate();
              const outcome = await kit.replace({
                kind: "conversation",
                agentId: target.agentId,
                sessionId: null,
                createRequestId,
              });
              if (outcome.kind === "refused") throw new Error(outcome.reason);
              createRequestId = undefined;
            },
            onForked:
              forked === undefined
                ? (sessionId) =>
                    kit
                      .replace({
                        kind: "conversation",
                        agentId: target.agentId,
                        sessionId,
                      })
                      .then((outcome) => {
                        if (outcome.kind === "refused")
                          throw new Error(outcome.reason);
                      })
                : (sessionId) => forked(sessionId, kit.paneId),
            // A row's conversation opens beside this one, never over it.
            onOpen: (open) =>
              kit
                .open({
                  kind: "conversation",
                  ...conversationNavigation(open),
                })
                .then((outcome) => {
                  if (outcome.kind === "refused")
                    kit.notify({ tone: "error", message: outcome.reason });
                }),
          }),
        );
      },
    };
  },
};
