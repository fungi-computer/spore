import { createCliRenderer, resolveRenderLib } from "@opentui/core";
import { registerModBindings } from "@opentui/keymap/addons";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { createRoot } from "@opentui/react";
import { QueryClient } from "@tanstack/query-core";
import {
  createAppSurfaceCommandHost,
  type AppSurfaceCommandHost,
} from "@fungi.computer/oyster/shell/command-host";
import {
  createWhistle,
  createWhistleKeymapAdapter,
  type WhistleKeymapHost,
  type WhistleRuntime,
} from "@fungi.computer/whistle";
import { leaderKeys } from "@fungi.computer/oyster/shell/keys";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { createToolSigilProbe } from "./tool-sigil-probe.js";
import {
  loadToolSigils as installToolSigils,
  deleteToolSigils,
  wrapForTmuxPassthrough,
} from "./tool-sigils.js";
import type { ToolSigils } from "./button/index.js";
import { asCliFailure, combinedCliFailure } from "./cli-failure.js";
import { reportFailure } from "./button/log-event.js";
import { contributeTerminalExitCommands } from "./button/terminal-exit.js";
import { runTuiEffect } from "./effect-boundary.js";
import { rendererInteraction } from "./renderer-interaction.js";
import {
  createTerminalInputHandoff,
  type TerminalInputHandoff,
} from "./button/terminal-input-handoff.js";

export type TerminalApplicationDependencies = Readonly<{
  signals: Readonly<{
    on: (signal: "SIGHUP" | "SIGTERM", listener: () => void) => void;
    off: (signal: "SIGHUP" | "SIGTERM", listener: () => void) => void;
  }>;
  createQueryClient: () => QueryClient;
  createRenderer: typeof createCliRenderer;
  createRoot: typeof createRoot;
  createWhistle: typeof createWhistle;
  enableKeymap: boolean;
  probeSigils?: boolean;
}>;

export type TerminalApplication = Readonly<{
  loadToolSigils: (
    mode: "auto" | "on" | "off",
  ) => Promise<ToolSigils | undefined>;
  commands: WhistleRuntime;
  commandHost: AppSurfaceCommandHost;
  queryClient: QueryClient;
  root: ReturnType<typeof createRoot>;
  inputHandoff: TerminalInputHandoff | undefined;
  signal: AbortSignal;
  destroyed: () => boolean;
  setExitHandler: (handler: (() => void) | undefined) => void;
  setQuitGuard: (guard: (() => Promise<boolean>) | undefined) => void;
  exit: () => void;
  close: () => Promise<void>;
}>;

function acquire<Value>(open: () => Value, close: (value: Value) => void) {
  return Effect.acquireRelease(Effect.sync(open), (value) =>
    Effect.sync(() => {
      close(value);
    }),
  );
}

/**
 * OpenTUI's own native layer derives multiplexer identity from the TMUX
 * environment variable first, falling back to a `TERM` prefix
 * (`packages/native/src/terminal.zig` `checkEnvironmentOverrides`), rather
 * than from any terminal round trip. Its JS-side `capabilities.multiplexer`
 * mirrors that, but is only populated after `setupTerminal()` runs, which
 * production always awaits before this module ever sees the renderer, while
 * the test renderer skips it outright — so this checks the same two
 * environment signals directly instead of depending on that timing. tmux
 * overwrites TERM_PROGRAM (and TERM, unless `default-terminal` names
 * something else) with its own identity for the attached client, which is
 * why neither can be trusted as the *outer* terminal's identity below.
 */
function isTmuxMultiplexed(): boolean {
  return (
    process.env.TMUX !== undefined ||
    (process.env.TERM ?? "").startsWith("tmux")
  );
}

/** Graphics support alone does not establish Unicode-placeholder support. */
function hasPlaceholderTerminal(): boolean {
  const program = process.env.TERM_PROGRAM?.toLowerCase();
  return (
    process.env.HERDR_ENV === "1" ||
    process.env.TERM === "xterm-kitty" ||
    process.env.TERM === "xterm-ghostty" ||
    program === "kitty" ||
    program === "ghostty" ||
    // Admission here only clears the way to the positive-probe gate below;
    // it never renders sigils on tmux's say alone.
    isTmuxMultiplexed()
  );
}

/** The write callback OpenTUI's renderer should receive for one gutter-sigil
 * transport. Outside tmux this returns `writeOut` itself, byte-identical to
 * the direct Ghostty/Kitty/herdr path. Inside tmux, every complete escape
 * sequence passed to it is wrapped once for tmux's own passthrough so it
 * reaches the real outer terminal instead of being swallowed by tmux's
 * VT100 emulation. */
function createGraphicsWriter(
  tmux: boolean,
  writeOut: (data: string) => void,
): (data: string) => void {
  return tmux
    ? (data) => {
        writeOut(wrapForTmuxPassthrough(data));
      }
    : writeOut;
}

/** Own one OpenTUI process lifetime independently from selected Sessions. */
export async function openTerminalApplication(
  dependencies: TerminalApplicationDependencies,
): Promise<TerminalApplication | undefined> {
  const abort = new AbortController();
  let exitHandler: (() => void) | undefined;
  let quitGuard: (() => Promise<boolean>) | undefined;
  let quitPending = false;
  let closePromise: Promise<void> | undefined;
  let opening = true;
  let terminalDestroyed = false;
  let sigilImagesStarted = false;
  let toolSigilsPromise: Promise<ToolSigils | undefined> | undefined;
  const scope = await runTuiEffect(Scope.make());
  const close = (): Promise<void> => {
    terminalDestroyed = true;
    abort.abort();
    closePromise ??= Promise.resolve().then(() =>
      runTuiEffect(Scope.close(scope, Exit.void)),
    );
    return closePromise;
  };

  const forceExit = () => {
    if (terminalDestroyed) return;
    terminalDestroyed = true;
    abort.abort();
    // Observe now and collect through close() at the CLI boundary. Presentation
    // closes independently of pending service requests and client finalizers.
    if (!opening)
      void close().catch((cause: unknown) => {
        reportFailure("terminal-close-after-exit", cause);
      });
    exitHandler?.();
  };
  const exit = () => {
    if (terminalDestroyed || quitPending) return;
    if (quitGuard === undefined) {
      forceExit();
      return;
    }
    quitPending = true;
    void quitGuard().then(
      (allowed) => {
        quitPending = false;
        if (allowed) forceExit();
      },
      (cause: unknown) => {
        quitPending = false;
        return reportFailure("terminal-quit-admission", cause);
      },
    );
  };
  try {
    const resources = await runTuiEffect(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            dependencies.signals.on("SIGHUP", forceExit);
            dependencies.signals.on("SIGTERM", forceExit);
          }),
          () =>
            Effect.sync(() => {
              dependencies.signals.off("SIGHUP", forceExit);
              dependencies.signals.off("SIGTERM", forceExit);
            }),
        );
        const sigilProbe = yield* acquire(createToolSigilProbe, (active) => {
          active.close();
        });
        if (dependencies.probeSigils !== true) sigilProbe.close();
        const renderer = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              dependencies.createRenderer({
                ...rendererInteraction,
                prependInputHandlers: [sigilProbe.observe],
                onDestroy: forceExit,
                consoleMode: "disabled",
              }),
            catch: (cause) =>
              asCliFailure(cause, "Local TUI renderer open failed"),
          }),
          (active) => {
            return Effect.sync(() => {
              if (!active.isDestroyed) {
                try {
                  if (sigilImagesStarted)
                    deleteToolSigils(
                      createGraphicsWriter(isTmuxMultiplexed(), (data) => {
                        resolveRenderLib().writeOut(active.rendererPtr, data);
                      }),
                    );
                } finally {
                  active.destroy();
                }
              }
            });
          },
        );
        if (terminalDestroyed) return undefined;
        const inputHandoff =
          "keyInput" in renderer
            ? yield* acquire(
                () => createTerminalInputHandoff(renderer.keyInput),
                (active) => {
                  active.close();
                },
              )
            : undefined;
        const queryClient = yield* acquire(
          dependencies.createQueryClient,
          (active) => {
            active.clear();
          },
        );
        const commands = yield* acquire(
          dependencies.createWhistle,
          (active) => {
            active.close();
          },
        );
        const commandHost = yield* acquire(
          () => createAppSurfaceCommandHost(commands),
          (active) => {
            active.dispose();
          },
        );
        yield* acquire(
          () =>
            contributeTerminalExitCommands(commands, {
              exit,
              ctrlC: () => {
                exit();
                return Promise.resolve();
              },
            }),
          (lease) => {
            lease.dispose();
          },
        );
        const keymap =
          dependencies.enableKeymap && "keyInput" in renderer
            ? yield* acquire(
                () => {
                  const nativeKeymap = createDefaultOpenTuiKeymap(renderer);
                  const detachModBindings = registerModBindings(nativeKeymap);
                  const adapter = createWhistleKeymapAdapter(
                    {
                      registerLayer: (layer) =>
                        nativeKeymap.registerLayer({
                          // The shell owns these two-step choices; OpenTUI owns direct chords.
                          bindings: layer.bindings.filter(
                            (binding) =>
                              !leaderKeys(commandHost.active()).some(
                                (row) =>
                                  row.commandId === binding.cmd &&
                                  row.binding === binding.key,
                              ),
                          ),
                          commands: layer.commands,
                          target: renderer.root,
                          priority: 100,
                        }),
                    } satisfies WhistleKeymapHost,
                    {
                      snapshot: commandHost.active,
                      subscribe: commandHost.subscribe,
                      execute: commandHost.execute,
                    },
                    "keyboard",
                  );
                  return {
                    cleanup: () => {
                      adapter.cleanup();
                      detachModBindings();
                    },
                  };
                },
                (active) => {
                  active.cleanup();
                },
              )
            : undefined;
        const root = yield* acquire(
          () => dependencies.createRoot(renderer),
          (active) => {
            active.unmount();
          },
        );
        return {
          renderer,
          sigilProbe,
          queryClient,
          commands,
          commandHost,
          keymap,
          root,
          inputHandoff,
        };
      }).pipe(Scope.provide(scope)),
    );
    opening = false;
    if (resources === undefined || abort.signal.aborted) {
      await close();
      return undefined;
    }
    return {
      loadToolSigils: async (mode) => {
        if (
          mode === "off" ||
          process.env.FUNGI_TUI_SIGILS === "off" ||
          (mode === "auto" && !hasPlaceholderTerminal())
        ) {
          resources.sigilProbe.close();
          return undefined;
        }
        if (!(await resources.sigilProbe.result) || terminalDestroyed)
          return undefined;
        try {
          toolSigilsPromise ??= (() => {
            sigilImagesStarted = true;
            return installToolSigils(
              createGraphicsWriter(isTmuxMultiplexed(), (data) => {
                if (!resources.renderer.isDestroyed)
                  resolveRenderLib().writeOut(
                    resources.renderer.rendererPtr,
                    data,
                  );
              }),
            );
          })();
          const glyphs = await toolSigilsPromise;
          return abort.signal.aborted || resources.renderer.isDestroyed
            ? undefined
            : glyphs;
        } catch (cause) {
          reportFailure("tool-sigil-assets", cause);
          return undefined;
        }
      },
      commands: resources.commands,
      commandHost: resources.commandHost,
      queryClient: resources.queryClient,
      root: resources.root,
      inputHandoff: resources.inputHandoff,
      signal: abort.signal,
      destroyed: () => terminalDestroyed,
      setExitHandler: (handler) => {
        exitHandler = handler;
      },
      setQuitGuard: (guard) => {
        quitGuard = guard;
      },
      exit,
      close,
    };
  } catch (cause) {
    try {
      await close();
    } catch (cleanup) {
      throw combinedCliFailure(
        asCliFailure(cause, "Local terminal startup failed"),
        [asCliFailure(cleanup, "Local terminal cleanup failed")],
      );
    }
    throw asCliFailure(cause, "Local terminal startup failed");
  }
}
