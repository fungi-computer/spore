import {
  createElement,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  PaneProvider,
  usePaneKit,
  usePaneFocused,
  Picker,
  defineIdFamily,
  z,
  openLocalTerminal,
  terminalText,
  reportFailure,
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
      terminal.resize(viewport.width, Math.max(1, viewport.height - 2));
    };
    resize();
    return kit.viewport.subscribe(resize);
  }, [kit, terminal]);
  useEffect(() => {
    const lease = kit.commands.contribute([
      {
        id: "interrupt",
        title: "Interrupt local process",
        category: "Advanced",
        projections: { bindings: { values: ["ctrl+c"], order: -1 } },
        handler: ({ origin }) => {
          if (!human.has(origin))
            throw new WhistleActionError(
              "human_required",
              "Only local keyboard input can control this terminal",
            );
          terminal.write("\x03");
        },
      },
      {
        id: "literal-leader",
        title: "Send Ctrl K to shell",
        category: "Advanced",
        projections: { palette: { order: 0 } },
        handler: ({ origin }) => {
          if (!human.has(origin))
            throw new WhistleActionError(
              "human_required",
              "Only local keyboard input can control this terminal",
            );
          terminal.write("\x0b");
        },
      },
    ]);
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
    const confirm = (quitting: boolean) => {
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
                  name: quitting
                    ? "Keep shells running"
                    : "Keep local shell open",
                },
                {
                  name: quitting ? "Quit and terminate" : "Terminate and close",
                },
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
                if (quitting) {
                  resolve(true);
                  handle.dismiss();
                  return;
                }
                void terminal.close().then(
                  () => {
                    resolve(true);
                    handle.dismiss();
                  },
                  (cause: unknown) => {
                    kit.notify({
                      tone: "error",
                      message: "The local shell could not be closed cleanly",
                    });
                    resolve(false);
                    handle.dismiss();
                    return reportFailure("local-terminal-confirm-close", cause);
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
    };
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
    <box flexDirection="column" width="100%" height="100%">
      <text height={1} fg={colors.info}>
        Local machine · {terminalText(frame.cwd)}
      </text>
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
      {/* Footers carry no key hints; this row reports only a finished shell. */}
      <text height={1} fg={colors.warning}>
        {frame.live ? "" : `${label} exited (${String(frame.exitCode ?? 0)})`}
      </text>
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
          const terminal = await openLocalTerminal({
            columns: viewport.width,
            rows: Math.max(1, viewport.height - 2),
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
