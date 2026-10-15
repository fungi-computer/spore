import { createAppPaneService } from "./app-pane-service.js";
import {
  createParakeetInteractions,
  type ModelAccountContext,
  type ParakeetInteractions,
  type ReloadSource,
} from "@fungi.computer/parakeet/headless";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { PrivateLocalServiceManager } from "@fungi.computer/local/service";
import type { WhistleRuntime } from "@fungi.computer/whistle";
import type { createRoot } from "@opentui/react";
import type { QueryClient } from "@tanstack/query-core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { asCliFailure, combinedCliFailure } from "./cli-failure.js";
import { reportFailure } from "./button/log-event.js";
import { runTuiEffect } from "./effect-boundary.js";
import type { prepareClientExtensions } from "./client-extensions.js";
import {
  selectTuiSession,
  type TuiSessionMount,
  type TuiSessionPickerRenderer,
} from "./session-navigation.js";
import type { TerminalApplication } from "./terminal-application.js";
import type {
  InstalledUpdateRestart,
  UpdateRestartSession,
} from "./update-restart.js";
import type {
  ThemeFrameProps,
  TuiCliOptions,
  TuiFrameControls,
} from "./tui-cli-contract.js";

export type SelectedSessionDependencies = Readonly<{
  checkInstalledUpdate?:
    | ((
        sessions: readonly UpdateRestartSession[],
      ) => Promise<InstalledUpdateRestart | undefined>)
    | undefined;
  discoverSessions?: PrivateLocalServiceManager["discover"] | undefined;
  prepareClientExtensions: typeof prepareClientExtensions;
  render: (
    root: ReturnType<typeof createRoot>,
    queryClient: QueryClient,
    session: TuiSessionMount["session"],
    commands: WhistleRuntime,
    onExit: () => void,
    theme: ThemeFrameProps,
    controls: TuiFrameControls,
  ) => void;
  renderPicker: TuiSessionPickerRenderer;
  renderConnecting: (root: ReturnType<typeof createRoot>) => void;
  renderRecovery: (
    root: ReturnType<typeof createRoot>,
    error: Error,
    retry: () => void,
    exit: () => void,
  ) => void;
  renderServiceMismatch: (
    root: ReturnType<typeof createRoot>,
    message: string,
    upgrade: (() => void) | undefined,
    exit: () => void,
  ) => void;
  clientBuildId: string | undefined;
}>;

export type SelectedSessionApplication = Readonly<{
  restartInstalledUpdate?:
    | ((update: Extract<InstalledUpdateRestart, { kind: "restart" }>) => void)
    | undefined;
  account: ModelAccountContext;
  commands: WhistleRuntime;
  queryClient: QueryClient;
  root: ReturnType<typeof createRoot>;
  serviceManager: PrivateLocalServiceManager;
  terminal: TerminalApplication;
  theme: () => ThemeFrameProps;
  onDiagnostic: (cause: Error) => void;
}>;

/** `--extension` clients load once per application; nothing unloads them. */
const clientExtensionReload: ReloadSource = {
  name: "client extensions",
  effect: "unsupported",
  reason: "loaded once at startup; replacing one needs an unload lifecycle",
};

/**
 * What the Local host already re-reads at the start of every turn (its
 * instruction source and skill catalog) and what it fixes at service start.
 */
const localReload: readonly ReloadSource[] = [
  { name: "AGENTS.md instructions", effect: "next_turn" },
  { name: "skills", effect: "next_turn" },
  {
    name: "Session extensions",
    effect: "unsupported",
    reason:
      "fixed when the Local service starts; replacing one needs an unload lifecycle",
  },
  clientExtensionReload,
];

const serviceMismatchNotice =
  "Client and shared Local service have different builds. Upgrade waits for active turns to finish, starts the installed service, and reopens this Session. Other clients may need to reconnect afterward.";

const sessionCreateRequests = defineIdFamily({
  family: "tui-session-create-request",
  version: 1,
  kinds: { request: { prefix: "request" } },
});

type Selection = {
  host: TuiSessionMount;
  scope: Scope.Closeable;
  interactionStore: ParakeetInteractions;
};

/** Keep the selected client usable until its replacement has actually opened. */
export async function runSessionApplication(
  options: TuiCliOptions,
  dependencies: SelectedSessionDependencies,
  application: SelectedSessionApplication,
): Promise<void> {
  const { terminal, root, commands, queryClient, serviceManager, theme } =
    application;
  const scope = await runTuiEffect(Scope.make());
  const appPanes = createAppPaneService();
  let notice: string | undefined;
  const extensionFailures: string[] = [];
  let current: Selection | undefined;
  const selections = new Set<Selection>();
  let selectedOnce = false;
  const extensions = await runTuiEffect(
    dependencies
      .prepareClientExtensions({
        invocationRoot: options.invocationRoot,
        entries: options.extensions ?? [],
        clients: options.clients,
        queryClient,
        onError: (cause) => {
          application.onDiagnostic(cause);
          if (terminal.destroyed()) return;
          const message = `Client extension: ${cause.message}`;
          if (selections.size === 0) extensionFailures.push(message);
          else
            for (const selection of selections)
              selection.interactionStore.report({ tone: "error", message });
        },
      })
      .pipe(Scope.provide(scope)),
  );
  const clients = await runTuiEffect(extensions.entries);
  let pending: Promise<void> | undefined;
  let pendingCreateRequestId: string | undefined;
  let failure: Error | undefined;
  const completed = Promise.withResolvers<undefined>();
  let checkingInstalledUpdate: Promise<boolean> | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  const hasPendingSelection = () => pending !== undefined;
  const checkInstalledClient = (): Promise<boolean> => {
    if (
      terminal.destroyed() ||
      current === undefined ||
      hasPendingSelection() ||
      dependencies.checkInstalledUpdate === undefined
    )
      return Promise.resolve(false);
    checkingInstalledUpdate ??= (async () => {
      const selected = current;
      const ordered = [
        selected,
        ...[...selections].filter((value) => value !== selected),
      ];
      const update = await dependencies.checkInstalledUpdate?.(
        ordered.map(({ host }) => ({
          invocationRoot: options.invocationRoot,
          sessionId: host.sessionId,
        })),
      );
      if (
        terminal.destroyed() ||
        current !== selected ||
        hasPendingSelection() ||
        selections.size !== ordered.length ||
        update === undefined
      )
        return false;
      if (
        update.kind === "restart" &&
        application.restartInstalledUpdate !== undefined
      ) {
        application.restartInstalledUpdate(update);
        terminal.setQuitGuard(undefined);
        terminal.exit();
      }
      return true;
    })().finally(() => {
      checkingInstalledUpdate = undefined;
    });
    return checkingInstalledUpdate;
  };
  const scheduleInstalledCheck = () => {
    if (dependencies.checkInstalledUpdate === undefined || terminal.destroyed())
      return;
    updateTimer = setTimeout(() => {
      void checkInstalledClient()
        .catch((cause: unknown) => {
          application.onDiagnostic(
            asCliFailure(cause, "Installed update restart check failed"),
          );
        })
        .finally(scheduleInstalledCheck);
    }, 1_000);
  };
  terminal.setExitHandler(() => {
    completed.resolve(undefined);
  });
  const serviceBuildMismatch = async () => {
    if (dependencies.clientBuildId === undefined) return false;
    const status = await serviceManager.status();
    return (
      status?.buildId !== undefined &&
      status.buildId !== dependencies.clientBuildId
    );
  };
  const closeScope = (owned: Scope.Closeable) =>
    runTuiEffect(Scope.close(owned, Exit.void));

  const select = (selectionOptions: TuiCliOptions) =>
    selectTuiSession({
      options: selectionOptions,
      serviceManager,
      discoverSessions: dependencies.discoverSessions,
      renderPicker: (...args) => {
        terminal.inputHandoff?.pause();
        dependencies.renderPicker(...args);
      },
      root,
      theme: theme(),
      signal: terminal.signal,
      destroyed: terminal.destroyed,
      onNotice: (message) => {
        notice = message;
      },
    });

  const acquireSelection = async (
    open: () => Promise<TuiSessionMount | undefined>,
    owned: Scope.Closeable,
    signal: AbortSignal,
  ): Promise<Selection | undefined> => {
    // Acquisition retains ownership until its finalizer is registered, including
    // a late connection returned after the terminal's signal was cancelled.
    const host = await runTuiEffect(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: open,
          catch: (cause) => asCliFailure(cause, "Session selection failed"),
        }),
        (value) =>
          Effect.tryPromise({
            try: () => value?.close() ?? Promise.resolve(),
            catch: (cause) =>
              asCliFailure(cause, "Selected client close failed"),
          }).pipe(Effect.orDie),
      ).pipe(Scope.provide(owned)),
    );
    if (host === undefined || terminal.destroyed() || signal.aborted)
      return undefined;
    if (selections.size === 0) terminal.inputHandoff?.capture();
    const interactionStore = await runTuiEffect(
      Effect.acquireRelease(Effect.sync(createParakeetInteractions), (store) =>
        Effect.sync(store.close),
      ).pipe(Scope.provide(owned)),
    );
    return { host, scope: owned, interactionStore };
  };

  const navigate = (
    open: () => Promise<TuiSessionMount | undefined>,
    replacePaneId?: string,
  ): Promise<void> => {
    if (pending !== undefined || terminal.destroyed())
      return Promise.reject(
        new Error("Another Local transition is already pending"),
      );
    pending = (async () => {
      const nextScope = await runTuiEffect(Scope.fork(scope, "sequential"));
      let retained = false;
      let selectionFailure: Error | undefined;
      try {
        const next = await acquireSelection(open, nextScope, terminal.signal);
        if (next === undefined) return;
        const { host, interactionStore } = next;
        const existing = [...selections].find(
          (selection) =>
            selection.host.agentId === host.agentId &&
            selection.host.sessionId === host.sessionId,
        );
        if (existing !== undefined) {
          current = existing;
          render(existing, replacePaneId);
          return;
        }
        const previous = current;
        current = next;
        selections.add(next);
        selectedOnce = true;
        try {
          render(next, replacePaneId);
        } catch (cause) {
          current = previous;
          selections.delete(next);
          throw cause;
        }
        retained = true;
        // Each optional attachment is a child of the selected scope.
        if (!terminal.destroyed())
          await runTuiEffect(
            extensions
              .attach(host.session, interactionStore)
              .pipe(Scope.provide(nextScope)),
          );
      } catch (cause) {
        selectionFailure = asCliFailure(cause, "Session selection failed");
        throw selectionFailure;
      } finally {
        if (!retained)
          await closeScope(nextScope).catch((cause: unknown) => {
            throw combinedCliFailure(selectionFailure, [
              asCliFailure(cause, "Candidate client cleanup failed"),
            ]);
          });
      }
    })().finally(() => {
      pending = undefined;
    });
    // Observe callback rejection immediately; the invoking command still receives it.
    void pending.catch((cause: unknown) => {
      reportFailure("session-selection-callback", cause);
    });
    return pending;
  };

  let upgradingService = false;
  const showServiceMismatch = (
    message: string,
    selection: TuiCliOptions,
    replacePaneId?: string,
  ) => {
    terminal.inputHandoff?.pause();
    dependencies.renderServiceMismatch(
      root,
      message,
      () => {
        if (upgradingService || terminal.destroyed()) return;
        upgradingService = true;
        void (async () => {
          try {
            dependencies.renderServiceMismatch(
              root,
              "Waiting for running turns to finish before upgrading the shared service…",
              undefined,
              terminal.exit,
            );
            const before = await serviceManager.status();
            if (
              before?.buildId !== undefined &&
              before.buildId !== dependencies.clientBuildId
            )
              await serviceManager.stop(before.serviceId);
            const started = await serviceManager.start();
            if (
              dependencies.clientBuildId !== undefined &&
              started.buildId !== dependencies.clientBuildId
            )
              throw new Error(
                "The installed client started a service with a different build",
              );
            await pending;
            dependencies.renderConnecting(root);
            await navigate(() => select(selection), replacePaneId);
          } catch (cause) {
            reportFailure("service-upgrade", cause);
            if (!terminal.destroyed())
              showServiceMismatch(
                `${asCliFailure(cause, "Service upgrade failed").message}. Running turns remain with the service. You can retry here. If that fails, let active turns finish, run fungi stop, then fungi resume in this project and choose this Session.`,
                selection,
                replacePaneId,
              );
          } finally {
            upgradingService = false;
          }
        })();
      },
      terminal.exit,
    );
  };

  const controlsFor = (selection: Selection): TuiFrameControls => {
    const { host } = selection;
    const ownsView = () => !terminal.destroyed() && selections.has(selection);
    let checkingServiceBuild = false;
    /** A fresh Session of this Agent, in `paneId` or else in a new pane. */
    const createConversation = async (paneId: string | undefined) => {
      if (!ownsView()) return;
      const requestId = (pendingCreateRequestId ??=
        sessionCreateRequests.request.generate());
      await navigate(
        () =>
          serviceManager.createSession(
            {
              invocationRoot: options.invocationRoot,
              databasePath: host.databasePath,
              requestId,
              fungiMcp: options.fungiMcp,
            },
            { signal: terminal.signal },
          ),
        paneId,
      );
      pendingCreateRequestId = undefined;
    };
    return {
      acquireSession: acquireTarget,
      apps: appPanes.apps,
      paneKinds: options.paneKinds,
      commandHost: terminal.commandHost,
      setQuitGuard: terminal.setQuitGuard,
      target: {
        kind: "conversation",
        agentId: host.agentId,
        sessionId: host.sessionId,
      },
      onClose: async () => {
        if (!selections.delete(selection)) return;
        if (current === selection) current = undefined;
        await closeScope(selection.scope);
      },
      openConversation: () => createConversation(undefined),
      chooseConversation: () =>
        navigate(() =>
          select({
            ...options,
            sessionId: undefined,
            databasePath: undefined,
            resume: true,
            last: false,
          }),
        ),
      interactionStore: selection.interactionStore,
      clients,
      inputHandoff: terminal.inputHandoff,
      initialCommandError:
        [options.initialCommandError, ...extensionFailures]
          .filter((message) => message !== undefined)
          .join("\n") || undefined,
      initialCommandNotice: notice,
      sessionTitle: async (signal) =>
        (
          await (dependencies.discoverSessions ?? serviceManager.discover)(
            options.invocationRoot,
            { signal },
          )
        ).sessions.find((item) => item.sessionId === host.sessionId)?.title,
      modelSource: {
        account: application.account,
        identity: host.session.address,
        models: (signal) => serviceManager.models({ signal }),
        effectiveModel: (signal) => host.effectiveModel({ signal }),
        modelPreference: host.session.modelPreference,
      },
      reloadSources: localReload,
      onResume: async (paneId) => {
        if (!ownsView()) return;
        await navigate(
          () =>
            select({
              ...options,
              databasePath: undefined,
              sessionId: undefined,
              resume: true,
              last: false,
            }),
          paneId,
        );
      },
      onNew: (paneId) => createConversation(paneId),
      onForked: async (sessionId: string, paneId: string) => {
        if (!ownsView()) return;
        await navigate(
          () =>
            select({
              ...options,
              databasePath: host.databasePath,
              sessionId,
            }),
          paneId,
        );
      },
      onObservationUnavailable: async (paneId) => {
        if (
          !ownsView() ||
          checkingServiceBuild ||
          dependencies.clientBuildId === undefined
        )
          return !ownsView();
        checkingServiceBuild = true;
        try {
          if (await checkInstalledClient()) return true;
          const mismatch = await serviceBuildMismatch();
          if (!ownsView() || !mismatch) return !ownsView();
          showServiceMismatch(
            serviceMismatchNotice,
            {
              ...options,
              databasePath: host.databasePath,
              sessionId: host.sessionId,
            },
            paneId,
          );
          return true;
        } catch (cause) {
          application.onDiagnostic(
            asCliFailure(cause, "Service build check failed"),
          );
          return false;
        } finally {
          checkingServiceBuild = false;
        }
      },
    };
  };

  const contextFor = (
    selection: Selection,
  ): import("./button/index.js").PaneSessionContext => {
    const controls = controlsFor(selection);
    const settings = theme();
    return {
      agentName: "Shiitake",
      clients: controls.clients,
      interactions: controls.interactionStore,
      models: controls.modelSource,
      sessionTitle: controls.sessionTitle,
      reload: controls.reloadSources,
      observationUnavailable: controls.onObservationUnavailable,
      themeName: settings.initialTheme,
      saveTheme: settings.onThemeConfirm,
      themeError: settings.themeError,
      initialError: controls.initialCommandError,
      initialNotice: controls.initialCommandNotice,
      resume: controls.onResume,
      create: controls.onNew,
      forked: controls.onForked,
      inputHandoff: controls.inputHandoff,
    };
  };

  const acquireTarget: NonNullable<
    import("./frame.js").TuiFrameProps["acquireSession"]
  > = async (target, signal) => {
    if (
      target.sessionId !== null &&
      ![...selections].some(
        (selection) => selection.host.agentId === target.agentId,
      )
    ) {
      const discovery = await (
        dependencies.discoverSessions ?? serviceManager.discover
      )(options.invocationRoot, { signal });
      if (
        !discovery.sessions.some((item) => item.sessionId === target.sessionId)
      ) {
        const remote = await appPanes.openSession(
          { agentId: target.agentId, sessionId: target.sessionId },
          signal,
        );
        return {
          session: remote.session,
          close: remote.close,
          context: {
            themeName: theme().initialTheme,
            themeError: theme().themeError,
            saveTheme: theme().onThemeConfirm,
            reload: [clientExtensionReload],
            clients,
            interactions: createParakeetInteractions(),
          },
        };
      }
    }
    const owned = await runTuiEffect(Scope.fork(scope, "sequential"));
    let retained = false;
    let candidate: Selection | undefined;
    let acquisitionFailure: Error | undefined;
    try {
      const owner = [...selections].find(
        (selection) => selection.host.agentId === target.agentId,
      );
      const open = async (): Promise<TuiSessionMount> => {
        if (owner !== undefined) {
          if (target.sessionId === null)
            return serviceManager.createSession(
              {
                invocationRoot: options.invocationRoot,
                databasePath: owner.host.databasePath,
                requestId: target.createRequestId,
                fungiMcp: options.fungiMcp,
              },
              { signal },
            );
          return serviceManager.connect(
            {
              invocationRoot: options.invocationRoot,
              databasePath: owner.host.databasePath,
              sessionId: target.sessionId,
              fungiMcp: options.fungiMcp,
            },
            { signal },
          );
        }
        const discovery = await (
          dependencies.discoverSessions ?? serviceManager.discover
        )(options.invocationRoot, { signal });
        const choice = discovery.sessions.find(
          (item) => item.sessionId === target.sessionId,
        );
        if (choice === undefined)
          throw new Error("That Session is not available through Local");
        return choice.resume({ signal, fungiMcp: options.fungiMcp });
      };
      const selected = await acquireSelection(open, owned, signal);
      if (selected === undefined)
        throw new Error("Pane Session acquisition was cancelled");
      if (selected.host.agentId !== target.agentId)
        throw new Error("Local returned a different Agent for this Session");
      if (
        target.sessionId !== null &&
        selected.host.sessionId !== target.sessionId
      )
        throw new Error("Local returned a different Session");
      candidate = selected;
      selections.add(selected);
      await runTuiEffect(
        extensions
          .attach(selected.host.session, selected.interactionStore)
          .pipe(Scope.provide(owned)),
      );
      const context = contextFor(selected);
      const close = controlsFor(selected).onClose;
      retained = true;
      return { session: selected.host.session, context, close };
    } catch (cause) {
      acquisitionFailure = asCliFailure(
        cause,
        "Pane Session acquisition failed",
      );
      throw acquisitionFailure;
    } finally {
      if (!retained) {
        if (candidate !== undefined) selections.delete(candidate);
        await closeScope(owned).catch((cause: unknown) => {
          throw combinedCliFailure(acquisitionFailure, [
            asCliFailure(cause, "Pane Session cleanup failed"),
          ]);
        });
      }
    }
  };

  const render = (selection: Selection, replacePaneId?: string) => {
    dependencies.render(
      root,
      queryClient,
      selection.host.session,
      commands,
      terminal.exit,
      theme(),
      { ...controlsFor(selection), replacePaneId },
    );
    extensionFailures.length = 0;
  };

  try {
    while (!terminal.destroyed()) {
      try {
        dependencies.renderConnecting(root);
        await navigate(() => select(options));
        break;
      } catch (cause) {
        reportFailure("session-connect-recovery", cause);
        if (terminal.destroyed()) break;
        let mismatch = false;
        try {
          mismatch = await serviceBuildMismatch();
        } catch (checkCause) {
          application.onDiagnostic(
            asCliFailure(checkCause, "Service build check failed"),
          );
        }
        if (terminal.destroyed()) break;
        if (mismatch) {
          showServiceMismatch(
            `${asCliFailure(cause, "Session connection failed").message}. ${serviceMismatchNotice}`,
            options,
          );
          await completed.promise;
          break;
        }
        terminal.inputHandoff?.pause();
        const retry = await new Promise<boolean>((resolve, reject) => {
          const finish = (again: boolean) => {
            terminal.signal.removeEventListener("abort", cancelled);
            resolve(again);
          };
          const cancelled = () => {
            finish(false);
          };
          terminal.signal.addEventListener("abort", cancelled, { once: true });
          try {
            dependencies.renderRecovery(
              root,
              asCliFailure(cause, "Connection unavailable"),
              () => {
                finish(true);
              },
              terminal.exit,
            );
          } catch (renderFailure) {
            terminal.signal.removeEventListener("abort", cancelled);
            reject(
              asCliFailure(renderFailure, "Connection recovery display failed"),
            );
          }
        });
        if (!retry) break;
        terminal.inputHandoff?.capture();
      }
    }
    const hasSelected = () => selectedOnce;
    if (!hasSelected()) terminal.exit();
    scheduleInstalledCheck();
    if (!terminal.destroyed()) await completed.promise;
  } catch (cause) {
    if (!terminal.destroyed())
      failure = asCliFailure(cause, "Local TUI failed");
  } finally {
    if (updateTimer !== undefined) clearTimeout(updateTimer);
    // Restore the terminal independently of remote/client cleanup completion.
    terminal.exit();
    terminal.setExitHandler(undefined);
  }
  const cleanup: Error[] = [];
  try {
    await pending;
  } catch (cause) {
    if (!terminal.signal.aborted)
      cleanup.push(asCliFailure(cause, "Session transition failed"));
  }
  try {
    await closeScope(scope);
  } catch (cause) {
    cleanup.push(asCliFailure(cause, "Selected client cleanup failed"));
  }
  if (failure !== undefined || cleanup.length > 0)
    throw combinedCliFailure(failure, cleanup);
}
