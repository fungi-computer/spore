import * as Effect from "effect/Effect";
import process from "node:process";
import {
  installedUpdateRestart,
  resumeInstalledUpdate,
  type InstalledUpdateRestart,
} from "./update-restart.js";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { asCliFailure, combinedCliFailure } from "./cli-failure.js";
import { reportFailure } from "./button/log-event.js";
import {
  createPrivateLocalServiceManager,
  type PrivateLocalServiceManager,
} from "@fungi.computer/local/service";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { QueryClient } from "@tanstack/query-core";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { createPrivateModels } from "@fungi.computer/local";
import { localAccountOwner } from "@fungi.computer/local/login";
import {
  contributeAccountCommands,
  type ModelAccountContext,
} from "@fungi.computer/parakeet/headless";
import { loginAllowed } from "@fungi.computer/veil/model-credentials";
import {
  renderTuiConversation,
  renderTuiSessionPicker,
  renderTuiConnecting,
  renderTuiConnectionRecovery,
  renderTuiServiceMismatch,
} from "./frame-renderer.js";
import {
  loadThemePreference,
  saveThemePreference,
} from "./button/theme-preferences.js";
import { runOneShot } from "./one-shot-run.js";
import { prepareClientExtensions } from "./client-extensions.js";
import {
  openTerminalApplication,
  type TerminalApplication,
  type TerminalApplicationDependencies,
} from "./terminal-application.js";
import {
  runSessionApplication,
  type SelectedSessionApplication,
  type SelectedSessionDependencies,
} from "./selected-session.js";
import { validateTuiSelection } from "./session-navigation.js";
import type { TuiCliOptions } from "./tui-cli-contract.js";

export type { TuiCliOptions } from "./tui-cli-contract.js";

export type TuiCliDependencies = Readonly<{
  resumeInstalledUpdate: typeof resumeInstalledUpdate;
  signals: TerminalApplicationDependencies["signals"];
  loadThemePreference: typeof loadThemePreference;
  saveThemePreference: typeof saveThemePreference;
  createWhistle: typeof createWhistle;
  createServiceManager: () => PrivateLocalServiceManager;
  createQueryClient: () => QueryClient;
  createRenderer: typeof createCliRenderer;
  createRoot: typeof createRoot;
  enableKeymap: boolean;
  renderConnecting: typeof renderTuiConnecting;
  runOneShot: typeof runOneShot;
  /** Pi providers Local may sign in to, already filtered by credential policy. */
  loginProviders: Parameters<typeof localAccountOwner>[1];
}> &
  SelectedSessionDependencies;

const defaultDependencies: TuiCliDependencies = {
  resumeInstalledUpdate,
  signals: process,
  loadThemePreference,
  saveThemePreference,
  createWhistle,
  createServiceManager: () => createPrivateLocalServiceManager(),
  prepareClientExtensions,
  createQueryClient,
  createRenderer: createCliRenderer,
  createRoot,
  render: (
    root: ReturnType<typeof createRoot>,
    queryClient,
    session,
    commands,
    onExit,
    theme,
    controls,
  ) => {
    renderTuiConversation(root, queryClient, {
      ...theme,
      commands,
      onExit,
      session,
      ...controls,
    });
  },
  renderConnecting: renderTuiConnecting,
  renderRecovery: renderTuiConnectionRecovery,
  renderServiceMismatch: renderTuiServiceMismatch,
  clientBuildId: process.env.FUNGI_BUNDLED_BUILD_ID,
  renderPicker: (root, sessions, onSelect, onCancel, theme) => {
    renderTuiSessionPicker(root, {
      ...theme,
      onCancel,
      onSelect,
      sessions,
    });
  },
  enableKeymap: true,
  runOneShot,
  loginProviders: () => createPrivateModels().getProviders(),
  checkInstalledUpdate:
    process.env.FUNGI_LAUNCHER === undefined
      ? undefined
      : async (sessions) => {
          const link = Bun.which("fungi");
          const running = process.env.FUNGI_LAUNCHER;
          if (link === null || running === undefined) return undefined;
          return installedUpdateRestart(link, running, sessions);
        },
} satisfies TuiCliDependencies;

async function collectCliCleanupFailure(
  cleanupFailures: Error[],
  close: () => void | Promise<void>,
  message: string,
) {
  try {
    await close();
  } catch (cause) {
    cleanupFailures.push(asCliFailure(cause, message));
  }
}

async function collectDefinedCliCleanupFailure<Value>(
  cleanupFailures: Error[],
  value: Value | undefined,
  close: (value: Value) => void | Promise<void>,
  message: string,
) {
  if (value === undefined) return;
  await collectCliCleanupFailure(cleanupFailures, () => close(value), message);
}

/** One terminal lifetime contains all Local Session and account transitions. */
export async function runTuiCli(
  options: TuiCliOptions,
  overrides: Partial<TuiCliDependencies> = {},
): Promise<void> {
  const dependencies: TuiCliDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  let failure: Error | undefined;
  let terminal: TerminalApplication | undefined;
  let installedRestart:
    Extract<InstalledUpdateRestart, { kind: "restart" }> | undefined;
  try {
    validateTuiSelection(options);
    terminal = await openTerminalApplication({
      signals: dependencies.signals,
      createQueryClient: dependencies.createQueryClient,
      createRenderer: dependencies.createRenderer,
      createRoot: dependencies.createRoot,
      createWhistle: dependencies.createWhistle,
      enableKeymap: dependencies.enableKeymap,
      probeSigils: process.stdin.isTTY,
    });
    if (terminal !== undefined) {
      dependencies.renderConnecting(terminal.root);
      const loaded = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () => dependencies.loadThemePreference(),
          catch: (cause) => asCliFailure(cause, "Theme preference unavailable"),
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              theme: "terminal" as const,
              error: error.message,
            }),
          ),
        ),
        { signal: terminal.signal },
      );
      if (Exit.isFailure(loaded)) {
        if (Cause.hasInterruptsOnly(loaded.cause)) {
          await terminal.close();
          return;
        }
        throw Cause.squash(loaded.cause);
      }
      const preference: import("./button/theme-preferences.js").ThemePreference =
        loaded.value;
      const toolSigils = await terminal.loadToolSigils(
        preference.sigils ?? "auto",
      );
      let confirmedTheme = preference.theme;
      let themeError = preference.error;
      const currentTheme = () => ({
        initialTheme: confirmedTheme,
        toolSigils,
        themeError,
        onThemeConfirm: async (next: typeof confirmedTheme) => {
          await dependencies.saveThemePreference(next);
          confirmedTheme = next;
          themeError = undefined;
        },
      });
      const serviceManager = dependencies.createServiceManager();
      const accountContext: ModelAccountContext = {
        owner: localAccountOwner(serviceManager, dependencies.loginProviders),
        host: "local",
        scope: "user",
        policy: { loginAllowed },
      };
      const application: SelectedSessionApplication = {
        restartInstalledUpdate: (update) => {
          installedRestart = update;
        },
        account: accountContext,
        commands: terminal.commands,
        queryClient: terminal.queryClient,
        root: terminal.root,
        serviceManager,
        terminal,
        theme: currentTheme,
        onDiagnostic: (cause) => {
          reportFailure("client-extension", cause);
        },
      };
      // Account commands live for the whole terminal, across Sessions; any
      // mounted frame renders their interactions.
      const account = contributeAccountCommands(
        terminal.commands,
        accountContext.owner,
        {
          sourceId: "local-account",
          namespace: "account",
          host: accountContext.host,
          scope: accountContext.scope,
          policy: accountContext.policy,
        },
      );
      try {
        await runSessionApplication(options, dependencies, application);
      } finally {
        account.dispose();
      }
    }
  } catch (cause) {
    failure = asCliFailure(cause, "Local TUI failed");
  }
  const cleanupFailures: Error[] = [];
  await collectDefinedCliCleanupFailure(
    cleanupFailures,
    terminal,
    (application) => application.close(),
    "Local terminal application cleanup failed",
  );
  if (failure !== undefined || cleanupFailures.length > 0)
    throw combinedCliFailure(failure, cleanupFailures);
  if (installedRestart !== undefined)
    await dependencies.resumeInstalledUpdate(installedRestart);
}
