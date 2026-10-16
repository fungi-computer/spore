import {
  createAppSurfaceCommandHost,
  type AppSurfaceCommandHost,
} from "@fungi.computer/oyster/shell/command-host";
import { useEffect, useRef, useState, useCallback } from "react";
import type {
  PaneTarget,
  PaneApps,
  PaneKindEntry,
  PaneSessionContext,
  PaneSession,
  ConversationPaneTarget,
  PaneSessionAcquisition,
  PaneSessionTarget,
} from "./button/index.js";
import {
  Picker,
  useTerminalTheme,
  CopySurface,
  copySurfaceColors,
  useDialog,
  reportFailure,
  type DialogController,
} from "./button/index.js";
import { ToolSigilContext, type ToolSigils } from "./button/index.js";
import { PaneWorkspace } from "./shell/workspace.js";
import type { createPaneRegistry } from "./shell/registry.js";
import type { TuiFrameProps as ConversationProps } from "./panes/conversation/frame.js";

export type TuiFrameProps = Omit<
  ConversationProps,
  | "commands"
  | "onOpen"
  | "applicationCommands"
  | "onResume"
  | "onNew"
  | "onForked"
  | "onObservationUnavailable"
> &
  Readonly<{
    commands: import("@fungi.computer/whistle").WhistleRuntime;
    toolSigils?: ToolSigils | undefined;
    target?: ConversationPaneTarget;
    /** Initial launch and explicit pane commands omit this; Session switches retain their pane. */
    replacePaneId?: string | undefined;
    onResume?: PaneSessionContext["resume"];
    onNew?: PaneSessionContext["create"];
    onForked?: PaneSessionContext["forked"];
    onObservationUnavailable?: PaneSessionContext["observationUnavailable"];
    openConversation?: (() => void | Promise<void>) | undefined;
    chooseConversation?: (() => void | Promise<void>) | undefined;
    commandHost?: AppSurfaceCommandHost;
    setQuitGuard?:
      ((guard: (() => Promise<boolean>) | undefined) => void) | undefined;
    apps?: PaneApps | undefined;
    /** Installed programs this project enabled, as pane kinds. */
    paneKinds?: readonly PaneKindEntry[] | undefined;
    acquireSession?:
      | ((
          target: PaneSessionTarget,
          signal: AbortSignal,
        ) => Promise<PaneSessionAcquisition>)
      | undefined;
    /** Observation/client release; never cancellation of Session work. */
    onClose?: (() => void | Promise<void>) | undefined;
  }>;
/** Shell configuration does not retain a closed Session or its projection. */
export type TuiWorkspaceConfiguration = Readonly<{
  commands: TuiFrameProps["commands"];
  toolSigils?: TuiFrameProps["toolSigils"];
  apps?: TuiFrameProps["apps"];
  paneKinds?: TuiFrameProps["paneKinds"];
  commandHost?: TuiFrameProps["commandHost"];
  setQuitGuard: TuiFrameProps["setQuitGuard"];
  acquireSession?: TuiFrameProps["acquireSession"];
  onExit?: TuiFrameProps["onExit"];
  chooseConversation?: TuiFrameProps["chooseConversation"];
  openConversation?: TuiFrameProps["openConversation"];
  initialTheme?: TuiFrameProps["initialTheme"];
}>;
export function workspaceConfiguration(
  props: TuiFrameProps,
): TuiWorkspaceConfiguration {
  return {
    commands: props.commands,
    toolSigils: props.toolSigils,
    apps: props.apps,
    paneKinds: props.paneKinds,
    commandHost: props.commandHost,
    setQuitGuard: props.setQuitGuard,
    acquireSession: props.acquireSession,
    onExit: props.onExit,
    chooseConversation: props.chooseConversation,
    openConversation: props.openConversation,
    initialTheme: props.initialTheme,
  };
}
export type TuiWorkspaceEntry = Readonly<{
  props: TuiFrameProps;
  request: number;
}>;

function targetFor(props: TuiFrameProps): ConversationPaneTarget {
  return (
    props.target ?? {
      kind: "conversation",
      agentId: props.session.address,
      sessionId: props.session.address,
    }
  );
}
function key(target: PaneSessionTarget) {
  return JSON.stringify([target.agentId, target.sessionId]);
}
/** A pane target also carries display fields; acquisition receives only the Session target. */
function sessionTarget(target: PaneSessionTarget): PaneSessionTarget {
  return target.sessionId === null
    ? {
        agentId: target.agentId,
        sessionId: null,
        createRequestId: target.createRequestId,
      }
    : { agentId: target.agentId, sessionId: target.sessionId };
}
function describe(props: TuiFrameProps): PaneSessionContext {
  return {
    clients: props.clients,
    interactions: props.interactionStore,
    models: props.modelSource,
    sessionTitle: props.sessionTitle,
    folder: props.folder,
    reload: props.reloadSources,
    observationUnavailable: props.onObservationUnavailable,
    themeName: props.initialTheme,
    saveTheme: props.onThemeConfirm,
    themeError: props.themeError,
    initialError: props.initialCommandError,
    initialNotice: props.initialCommandNotice,
    resume: props.onResume,
    create: props.onNew,
    forked: props.onForked,
    inputHandoff: props.inputHandoff,
  };
}

/** The native host entry: one pane shell even when only one Session is supplied. */
export function TuiFrame(props: TuiFrameProps) {
  const dialog = useDialog();
  return (
    <TuiWorkspace
      entries={[{ props, request: 1 }]}
      requested={1}
      dialog={dialog}
    />
  );
}

export function TuiWorkspace({
  entries,
  requested,
  dialog,
  configuration,
}: Readonly<{
  configuration?: TuiWorkspaceConfiguration | undefined;
  entries: readonly TuiWorkspaceEntry[];
  requested: number;
  dialog: DialogController;
}>) {
  const first = entries[0];
  const initial =
    configuration ??
    (first === undefined ? undefined : workspaceConfiguration(first.props));
  if (initial === undefined)
    throw new Error("Workspace requires its host configuration");
  return (
    <WorkspaceHost
      initial={initial}
      entries={entries}
      requested={requested}
      dialog={dialog}
    />
  );
}

function WorkspaceHost({
  initial,
  entries,
  requested,
  dialog,
}: Readonly<{
  initial: TuiWorkspaceConfiguration;
  entries: readonly TuiWorkspaceEntry[];
  requested: number;
  dialog: DialogController;
}>) {
  const pickerRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pickerRequest.current?.abort(), []);
  const [themeName, setThemeName] = useState(
    initial.initialTheme ?? "terminal",
  );
  // The pane's chooser owns confirmed refreshes; this shell reader only
  // requests an initial palette if no other reader has done so yet.
  const presentation = useTerminalTheme(themeName, {
    refreshOnReturnToTerminal: false,
  });
  // `sessions` below is built once, so panes opened later read the live theme
  // through this ref rather than the theme the Session launched with.
  const liveTheme = useRef(themeName);
  liveTheme.current = themeName;
  const current = useRef(entries);
  current.current = entries;
  const [commandHost] = useState(
    () => initial.commandHost ?? createAppSurfaceCommandHost(initial.commands),
  );
  const [registry, setRegistry] =
    useState<ReturnType<typeof createPaneRegistry>>();
  const onRegistry = useCallback(
    (next: ReturnType<typeof createPaneRegistry>) => {
      setRegistry(next);
    },
    [],
  );
  useEffect(() => {
    initial.setQuitGuard?.(registry?.canQuit);
    return () => initial.setQuitGuard?.(undefined);
  }, [initial.setQuitGuard, registry]);
  const [owned] = useState(() => ({
    retired: new WeakSet<PaneSession>(),
    contexts: new WeakMap<PaneSession, PaneSessionContext>(),
  }));
  const withThemeConfirmation = (
    context: PaneSessionContext,
  ): PaneSessionContext => ({
    ...context,
    themeName: liveTheme.current,
    saveTheme: async (theme) => {
      await context.saveTheme?.(theme);
      liveTheme.current = theme;
      setThemeName(theme);
    },
  });
  const [sessions] = useState(() => ({
    acquire: async (
      target: PaneSessionTarget,
      signal: AbortSignal,
    ): Promise<PaneSession> => {
      if (signal.aborted) throw signal.reason;
      const entry = current.current.find(
        ({ props }) =>
          key(targetFor(props)) === key(target) &&
          !owned.retired.has(props.session),
      );
      let session: PaneSession;
      let close: (() => void | Promise<void>) | undefined;
      if (entry === undefined) {
        const acquire = initial.acquireSession;
        if (acquire === undefined)
          throw new Error("That Session is not available through Local");
        const acquired = await acquire(sessionTarget(target), signal);
        session = acquired.session;
        close = acquired.close;
        owned.contexts.set(session, acquired.context);
      } else {
        session = entry.props.session;
        close = entry.props.onClose;
      }
      const closed = () => {
        owned.retired.add(session);
        owned.contexts.delete(session);
        const operation = close?.();
        if (operation !== undefined)
          void Promise.resolve(operation).catch((cause: unknown) =>
            reportFailure("pane-session-close", cause),
          );
      };
      const retired = () => signal.aborted;
      if (retired()) closed();
      else signal.addEventListener("abort", closed, { once: true });
      return session;
    },
    describe: (session: PaneSession) => {
      const acquired = owned.contexts.get(session);
      if (acquired !== undefined) return withThemeConfirmation(acquired);
      const props = current.current.find(
        (entry) => entry.props.session === session,
      )?.props;
      if (props === undefined)
        throw new Error("Session observation was retired");
      return withThemeConfirmation(describe(props));
    },
  }));
  useEffect(() => {
    const entry = current.current.find((item) => item.request === requested);
    if (registry === undefined || entry === undefined) return;
    const operation =
      entry.props.replacePaneId === undefined
        ? registry.open(targetFor(entry.props))
        : registry.replace(entry.props.replacePaneId, targetFor(entry.props));
    void operation
      .then((outcome) => {
        if (outcome.kind === "refused")
          registry.notify({ tone: "error", message: outcome.reason });
      })
      .catch((cause: unknown) => {
        reportFailure("conversation-pane-open", cause);
        registry.notify({
          tone: "error",
          message:
            cause instanceof Error
              ? cause.message
              : "Conversation pane could not open",
        });
        return { kind: "refused", reason: "Conversation pane could not open" };
      });
  }, [registry, requested]);
  useEffect(
    () => () => {
      if (initial.commandHost === undefined) commandHost.dispose();
    },
    [commandHost, initial.commandHost],
  );
  /**
   * The one Open action: every pane that can open now, by name. Built-in and
   * installed-program launchers come from the registry; conversations and
   * Apps are host flows.
   */
  const openPane = async () => {
    pickerRequest.current?.abort();
    const controller = new AbortController();
    pickerRequest.current = controller;
    const conversationOptions = [
      ...(initial.openConversation === undefined
        ? []
        : [
            {
              name: "New conversation",
              description: "Start a conversation in a new pane",
              open: async (handle: ReturnType<DialogController["show"]>) => {
                handle.dismiss();
                await initial.openConversation?.();
              },
            },
          ]),
      ...(initial.chooseConversation === undefined
        ? []
        : [
            {
              name: "Resume conversation",
              description: "Open a saved conversation",
              open: async (handle: ReturnType<DialogController["show"]>) => {
                handle.dismiss();
                await initial.chooseConversation?.();
              },
            },
          ]),
    ];
    const launcherOptions = (registry?.launchers ?? []).map((launcher) => ({
      name: launcher.name,
      description: launcher.description,
      open: async (handle: ReturnType<DialogController["show"]>) => {
        handle.dismiss();
        const outcome = await registry?.open(launcher.target);
        if (outcome?.kind === "refused") throw new Error(outcome.reason);
      },
    }));
    const apps = initial.apps;
    // Only choices that can work now: signed out, Apps is not offered.
    if (apps === undefined || !(await apps.signedIn(controller.signal))) {
      if (controller.signal.aborted) return;
      showChoices("Open pane", [...launcherOptions, ...conversationOptions]);
      return;
    }
    if (controller.signal.aborted) return;
    const options = [
      ...launcherOptions,
      ...conversationOptions,
      {
        name: "Apps",
        description: "Open an App pane or hand off to its App",
        open: async (handle: ReturnType<DialogController["show"]>) => {
          const directory = await apps.read(controller.signal);
          if (controller.signal.aborted || !handle.isCurrent()) return;
          const choices = directory.apps.flatMap((app) =>
            app.gills.length === 0
              ? [
                  {
                    name: app.displayName ?? app.appId,
                    description: "Open in your browser",
                    open: async (
                      handle: ReturnType<DialogController["show"]>,
                    ) => {
                      handle.dismiss();
                      await apps.openUi(app.surfaceId, controller.signal);
                    },
                  },
                ]
              : app.gills.map((gill) => ({
                  name: `${app.displayName ?? app.appId} · ${gill.title}`,
                  description:
                    app.availability === "available"
                      ? "Open App pane"
                      : "Unavailable",
                  open: async (
                    handle: ReturnType<DialogController["show"]>,
                  ) => {
                    handle.dismiss();
                    const outcome = await registry?.open({
                      kind: "gill",
                      surfaceId: app.surfaceId,
                      viewId: gill.id,
                      title: gill.title,
                    });
                    if (outcome?.kind === "refused")
                      throw new Error(outcome.reason);
                  },
                })),
          );
          if (choices.length === 0)
            throw new Error("This Team has no Apps yet");
          showChoices("Apps", choices);
        },
      },
    ];
    function showChoices(
      title: string,
      choices: readonly Readonly<{
        name: string;
        description: string;
        open: (handle: ReturnType<DialogController["show"]>) => Promise<void>;
      }>[],
    ) {
      dialog.show((handle) => (
        <Picker
          title={title}
          choices={choices}
          colors={presentation.colors}
          onCancel={() => {
            controller.abort();
            handle.dismiss();
          }}
          onSelect={(index) => {
            const selected = choices[index];
            if (selected === undefined) return;
            void selected.open(handle).catch((cause: unknown) => {
              if (controller.signal.aborted) return { kind: "retired", cause };
              handle.dismiss();
              reportFailure("pane-picker-open", cause);
              registry?.notify({
                tone: "error",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "The pane could not open",
              });
              return { kind: "failed", cause };
            });
          }}
        />
      ));
    }
    showChoices("Open pane", options);
  };
  return (
    <ToolSigilContext.Provider value={initial.toolSigils}>
      <CopySurface colors={copySurfaceColors}>
        <PaneWorkspace
          commandHost={commandHost}
          sessions={sessions}
          apps={initial.apps}
          additionalKinds={initial.paneKinds}
          theme={themeName}
          exit={() => initial.onExit?.()}
          onRegistry={onRegistry}
          dialog={dialog}
          openPane={openPane}
        />
      </CopySurface>
    </ToolSigilContext.Provider>
  );
}

export type { PaneTarget };
