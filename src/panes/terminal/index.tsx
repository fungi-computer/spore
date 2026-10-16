import {
  createElement,
  useEffect,
  useState,
  useSyncExternalStore,
  useRef,
} from "react";
import {
  PaneProvider,
  usePaneKit,
  usePaneFocused,
  Picker,
  defineIdFamily,
  z,
  openLocalTerminal,
  openMacTerminal,
  EmbeddedTerminalRenderable,
  applyNativeTerminalDefaults,
  reportFailure,
  type PaneKit,
  type LocalTerminalFrame,
  type PaneKindEntry,
} from "../../button/index.js";
import { admitTerminalTermination } from "./quit.js";
import { WhistleActionError } from "@fungi.computer/whistle";

const openings = defineIdFamily({
  family: "tui-terminal-open",
  version: 1,
  kinds: { request: { prefix: "terminal_open" } },
});
const human = new Set(["keyboard", "menu", "palette", "slash"]);

function contributeTerminalCommands(
  kit: PaneKit,
  send: (text: string) => void,
) {
  const humanInput = (origin: string, text: string) => {
    if (!human.has(origin))
      throw new WhistleActionError(
        "human_required",
        "Only local keyboard input can control this terminal",
      );
    send(text);
  };
  return kit.commands.contribute([
    {
      id: "interrupt",
      title: "Interrupt local process",
      category: "Advanced",
      projections: { bindings: { values: ["ctrl+c"], order: -1 } },
      handler: ({ origin }) => {
        humanInput(origin, "\x03");
      },
    },
    {
      id: "literal-leader",
      title: "Send Ctrl K to shell",
      category: "Advanced",
      projections: { palette: { order: 0 } },
      handler: ({ origin }) => {
        humanInput(origin, "\x0b");
      },
    },
  ]);
}

function confirmTerminalTermination(
  kit: PaneKit,
  colors: ReturnType<PaneKit["theme"]["read"]>["colors"],
  quitting: boolean,
  accept: () => Promise<boolean>,
) {
  return new Promise<boolean>((resolve) => {
    let answered = false;
    kit.dialogs.show(
      (handle) => (
        <Picker
          title={
            quitting
              ? "Quit and terminate running shell jobs?"
              : "Close local shell and terminate its jobs?"
          }
          colors={colors}
          choices={[
            {
              name: quitting ? "Keep shells running" : "Keep local shell open",
            },
            { name: quitting ? "Quit and terminate" : "Terminate and close" },
          ]}
          onCancel={handle.dismiss}
          onSelect={(index) => {
            if (answered) return;
            answered = true;
            if (index !== 1) {
              resolve(false);
              handle.dismiss();
              return;
            }
            void accept().then(
              (allowed) => {
                resolve(allowed);
                handle.dismiss();
              },
              (cause: unknown) => {
                reportFailure("local-terminal-confirm", cause);
                resolve(false);
                handle.dismiss();
              },
            );
          }}
        />
      ),
      {
        onDismiss: () => {
          if (!answered) resolve(false);
        },
      },
    );
  });
}

function TerminalPane({
  terminal,
  label,
}: Readonly<{
  terminal: Awaited<ReturnType<typeof openLocalTerminal>>;
  label: string;
}>) {
  const kit = usePaneKit();
  const [frame, setFrame] = useState<LocalTerminalFrame>(() => terminal.read());
  const colors = useSyncExternalStore(
    kit.theme.subscribe,
    kit.theme.read,
  ).colors;
  const focused = usePaneFocused();
  useEffect(
    () =>
      terminal.subscribe(() => {
        setFrame(terminal.read());
      }),
    [terminal],
  );
  useEffect(() => {
    const status = kit.status.contribute({
      slot: "state",
      order: 0,
      text: `${label} · ${frame.cwd}`,
      tone: "info",
    });
    return status.dispose;
  }, [kit, label, frame.cwd]);
  useEffect(() => {
    const resize = () => {
      const viewport = kit.viewport.read();
      terminal.resize(viewport.width, viewport.height);
    };
    resize();
    return kit.viewport.subscribe(resize);
  }, [kit, terminal]);
  useEffect(() => {
    const lease = contributeTerminalCommands(kit, (text) => {
      terminal.write(text);
    });
    const keys = kit.input.onKey((key) => {
      if (key.eventType === "release") return true;
      if (key.source === "raw") terminal.write(key.raw);
      else if (key.ctrl && key.name.length === 1)
        terminal.write(
          String.fromCharCode(key.name.toUpperCase().charCodeAt(0) & 31),
        );
      else {
        const named = new Map(
          Object.entries({
            return: "\r",
            enter: "\r",
            tab: "\t",
            backspace: "\x7f",
            escape: "\x1b",
            up: "\x1b[A",
            down: "\x1b[B",
            right: "\x1b[C",
            left: "\x1b[D",
            home: "\x1b[H",
            end: "\x1b[F",
            delete: "\x1b[3~",
          }),
        );
        const input =
          named.get(key.name) ?? (key.name.length === 1 ? key.name : undefined);
        if (input !== undefined) terminal.write(input);
      }
      return true;
    });
    const paste = kit.input.onPaste((event) => {
      terminal.paste(new TextDecoder().decode(event.bytes));
    });
    const confirm = (quitting: boolean) =>
      confirmTerminalTermination(kit, colors, quitting, async () => {
        if (quitting) return true;
        try {
          await terminal.close();
          return true;
        } catch (cause) {
          kit.notify({
            tone: "error",
            message: "The local shell could not be closed cleanly",
          });
          reportFailure("local-terminal-confirm-close", cause);
          return false;
        }
      });
    // An idle shell closes at once; only running jobs ask first.
    const guard = kit.guardClose(() =>
      admitTerminalTermination(
        () => terminal.hasRunningJobs(),
        () => confirm(false),
        kit.notify,
      ),
    );
    const quit = kit.guardQuit(() =>
      admitTerminalTermination(
        () => terminal.hasRunningJobs(),
        () => confirm(true),
        kit.notify,
      ),
    );
    return () => {
      lease.dispose();
      keys();
      paste();
      guard();
      quit();
    };
  }, [kit, terminal, colors]);
  return (
    <box flexDirection="column" width="100%" height="100%" position="relative">
      <box flexGrow={1} overflow="hidden">
        {frame.rows.map((row, y) => (
          <text key={y} height={1} wrapMode="none">
            {row.map((cell, x) => {
              const inverse =
                cell.inverse ||
                (frame.live &&
                  focused &&
                  frame.cursor.x === x &&
                  frame.cursor.y === y);
              return cell.width === 0 ? null : (
                <span
                  key={x}
                  fg={
                    inverse
                      ? (cell.background ?? colors.background)
                      : (cell.foreground ?? colors.foreground)
                  }
                  bg={
                    inverse
                      ? (cell.foreground ?? colors.foreground)
                      : (cell.background ?? colors.background)
                  }
                >
                  {cell.bold ? <b>{cell.text}</b> : cell.text}
                </span>
              );
            })}
          </text>
        ))}
      </box>
      {!frame.live ? (
        <TerminalExit label={label} exitCode={frame.exitCode} />
      ) : null}
    </box>
  );
}

/** An ended program gets an overlay, never a reserved row in a live PTY. */
function TerminalExit({
  label,
  exitCode,
  failure,
}: Readonly<{
  label: string;
  exitCode: number | undefined;
  failure?: string | undefined;
}>) {
  const kit = usePaneKit();
  const colors = useSyncExternalStore(
    kit.theme.subscribe,
    kit.theme.read,
  ).colors;
  return (
    <text
      position="absolute"
      bottom={0}
      left={0}
      height={1}
      fg={colors.warning}
      bg={colors.background}
    >
      {failure !== undefined
        ? `${label} connection lost: ${failure}`
        : exitCode === undefined
          ? `${label} ended without a known exit status`
          : `${label} exited (${String(exitCode)})`}
    </text>
  );
}

function MacTerminalPane({
  terminal,
  label,
}: Readonly<{
  terminal: Awaited<ReturnType<typeof openMacTerminal>>;
  label: string;
}>) {
  const kit = usePaneKit();
  const focused = usePaneFocused();
  const [live, setLive] = useState(terminal.live);
  const [exitCode, setExitCode] = useState(terminal.exitCode);
  const [failure, setFailure] = useState(terminal.failure);
  const native = useRef<EmbeddedTerminalRenderable>(null);
  const presentation = useSyncExternalStore(
    kit.theme.subscribe,
    kit.theme.read,
  );
  const { colors, nativeDefaults } = presentation;
  useEffect(
    () =>
      terminal.subscribe(() => {
        setLive(terminal.live);
        setExitCode(terminal.exitCode);
        setFailure(terminal.failure);
      }),
    [terminal],
  );
  useEffect(() => {
    const renderable = native.current;
    if (renderable === null) return;
    applyNativeTerminalDefaults(renderable, nativeDefaults);
  }, [nativeDefaults]);
  useEffect(() => {
    const attach = () => {
      if (!native.current) return;
      return terminal.onBytes((data) => native.current?.write(data));
    };
    return attach();
  }, [terminal]);
  useEffect(() => {
    const item = kit.status.contribute({
      slot: "state",
      order: 0,
      text: `${label} · ${terminal.cwd}`,
      tone: "info",
    });
    return item.dispose;
  }, [kit, terminal, label]);
  useEffect(() => {
    const keys = kit.input.onKey((key) => {
      if (key.eventType === "release") return true;
      native.current?.handleKeyPress(key);
      return true;
    });
    const paste = kit.input.onPaste((event) => {
      native.current?.handlePaste(event);
    });
    const lease = contributeTerminalCommands(kit, (text) => {
      if (!terminal.input(new TextEncoder().encode(text)))
        kit.notify({
          tone: "error",
          message: "Local terminal input was not sent",
        });
    });
    const confirm = (quitting: boolean) =>
      confirmTerminalTermination(kit, colors, quitting, () =>
        Promise.resolve(true),
      );
    const guardedClose = async () => {
      const admitted = await admitTerminalTermination(
        () => terminal.hasRunningJobs(),
        () => confirm(false),
        kit.notify,
      );
      if (!admitted) return false;
      try {
        await terminal.close();
        return true;
      } catch (cause) {
        kit.notify({
          tone: "error",
          message: "The local shell could not be closed cleanly",
        });
        reportFailure("mac-terminal-guard-close", cause);
        return false;
      }
    };
    const guard = kit.guardClose(guardedClose);
    // A later pane can still veto global quit. Only accepted workspace
    // disposal terminates this PTY; admission cannot kill it early.
    const quit = kit.guardQuit(() =>
      admitTerminalTermination(
        () => terminal.hasRunningJobs(),
        () => confirm(true),
        kit.notify,
      ),
    );
    return () => {
      keys();
      paste();
      lease.dispose();
      guard();
      quit();
    };
  }, [kit, terminal, colors]);
  // PaneKit, not the renderer's global focused renderable, exclusively routes
  // keyboard/paste. Focusing the native cell would install a competing listener.
  return (
    <box flexDirection="column" width="100%" height="100%" position="relative">
      <box flexGrow={1} overflow="hidden">
        <fungiTerminal
          ref={native}
          width="100%"
          height="100%"
          selectable={focused}
          onData={(data, source) => {
            if (source === "input" && !terminal.input(data))
              kit.notify({
                tone: "error",
                message: terminal.live
                  ? "Local terminal input was not sent; retry with a smaller paste"
                  : "Local terminal input was not sent; the program has ended",
              });
            // opencode-pty's Ghostty actor answers terminal queries; passing
            // OpenTUI responses back would duplicate them.
          }}
          onTerminalResize={(cols, rows) => {
            if (!terminal.resize(cols, rows))
              kit.notify({
                tone: "error",
                message: "Local terminal resize was not sent",
              });
          }}
        />
      </box>
      {!live ? (
        <TerminalExit label={label} exitCode={exitCode} failure={failure} />
      ) : null}
    </box>
  );
}

/** An installed program a project enabled; its command never comes from a target. */
export type LocalProgram = Readonly<{
  kind: string;
  name: string;
  description: string;
  command: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

function localTerminalKind(
  kind: string,
  name: string,
  description: string,
  label: string,
  program?: LocalProgram,
): PaneKindEntry {
  const targets = z.object({ kind: z.literal(kind) }).strict();
  return {
    kind,
    launcher: { name, description, target: { kind } },
    instantiate: (input) => {
      if (!targets.safeParse(input).success) return undefined;
      return {
        key: openings.request.generate(),
        title: name,
        render: async (kit) => {
          const viewport = kit.viewport.read();
          if (process.platform === "darwin") {
            const terminal = await openMacTerminal({
              columns: viewport.width,
              rows: viewport.height,
              program,
            });
            kit.onDispose(() => {
              void terminal.close().catch((cause: unknown) => {
                reportFailure("mac-terminal-close", cause);
              });
            });
            if (kit.signal.aborted) {
              await terminal.close();
              return null;
            }
            return createElement(
              PaneProvider,
              { kit },
              createElement(MacTerminalPane, { terminal, label }),
            );
          }
          const terminal = await openLocalTerminal({
            columns: viewport.width,
            rows: viewport.height,
            program,
          });
          const close = () => {
            void terminal
              .close()
              .catch((cause: unknown) =>
                reportFailure("local-terminal-close", cause),
              );
          };
          kit.onDispose(close);
          if (kit.signal.aborted) {
            await terminal.close();
            return null;
          }
          return createElement(
            PaneProvider,
            { kit },
            createElement(TerminalPane, { terminal, label }),
          );
        },
      };
    },
  };
}

export const terminalPane = localTerminalKind(
  "terminal",
  "Local terminal",
  "A shell on this machine",
  "Local shell",
);

/** One pane kind per installed program the project enabled. */
export function programPanes(
  programs: readonly LocalProgram[],
): readonly PaneKindEntry[] {
  return programs.map((program) =>
    localTerminalKind(
      program.kind,
      program.name,
      program.description,
      program.name,
      program,
    ),
  );
}
