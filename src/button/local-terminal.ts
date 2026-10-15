import { Terminal as Emulator } from "@xterm/headless";
import { killSessionProcesses } from "./local-terminal-processes.js";
import { loginShell } from "./login-shell.js";
import { reportFailure } from "./log-event.js";
import { terminalText } from "./terminal-text.js";
import process from "node:process";
import { z } from "zod";

export type TerminalCell = Readonly<{
  text: string;
  width: number;
  foreground?: string | undefined;
  background?: string | undefined;
  bold: boolean;
  inverse: boolean;
}>;
export type LocalTerminalFrame = Readonly<{
  rows: readonly (readonly TerminalCell[])[];
  cursor: Readonly<{ x: number; y: number }>;
  live: boolean;
  exitCode?: number | undefined;
  cwd: string;
}>;

const ansiColors = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];
function cellColor(value: number, palette: boolean): string {
  if (!palette) return `#${value.toString(16).padStart(6, "0")}`;
  const named = ansiColors[value];
  if (named !== undefined) return named;
  const levels = [0, 95, 135, 175, 215, 255];
  const cube = value - 16;
  const rgb =
    value >= 232
      ? [8 + (value - 232) * 10, 8 + (value - 232) * 10, 8 + (value - 232) * 10]
      : [
          levels[Math.floor(cube / 36)],
          levels[Math.floor(cube / 6) % 6],
          levels[cube % 6],
        ];
  return `#${rgb.map((channel) => (channel ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * What Fungi's launchers set for their own CLI process and nothing else:
 * `scripts/fungi.cjs` (npm) and `scripts/binary-entry.ts.txt` (compiled).
 */
const launcherVariables = new Set([
  "FUNGI_BUNDLED_CLI",
  "FUNGI_BUNDLED_BUILD_ID",
  "FUNGI_LAUNCHER",
  "FUNGI_LAUNCHER_NODE",
  "FUNGI_NODE",
]);

/** What the PTY session runs: an installed program, or an interactive login shell. */
async function terminalLaunch(
  program:
    | Readonly<{
        command: readonly string[];
        cwd: string;
        env: Readonly<Record<string, string>>;
      }>
    | undefined,
) {
  if (program !== undefined)
    // An installed program gets an explicit, minimal environment, not the
    // full inherited shell environment below.
    return {
      cwd: program.cwd,
      command: program.command,
      env: {
        ...program.env,
        TERM: "xterm-256color",
        PS1: "$ ",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TMPDIR: process.env.TMPDIR,
      },
    };
  const shell = await loginShell({ shell: process.env.SHELL });
  // Like any terminal emulator: the shell gets the environment the TUI was
  // started with (SSH_AUTH_SOCK, PATH additions, ...), less only what
  // Fungi's own launcher injected, and the terminal type this emulator
  // speaks.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !launcherVariables.has(name)) env[name] = value;
  env.TERM = "xterm-256color";
  env.SHELL = shell;
  // An interactive login shell, so profile and rc files load.
  return { cwd: process.cwd(), command: [shell, "-l", "-i"], env };
}

/** Local-human process owner. No remote target, command or credential channel. */
export async function openLocalTerminal(
  options: Readonly<{
    columns: number;
    rows: number;
    /** An installed program in place of the interactive shell. */
    program?:
      | Readonly<{
          command: readonly string[];
          cwd: string;
          env: Readonly<Record<string, string>>;
        }>
      | undefined;
  }>,
) {
  if (process.platform !== "linux")
    throw new Error(
      "Local terminal panes are currently qualified on Linux only",
    );
  const trustedLookup = { PATH: "/usr/bin:/bin" };
  const setsid = Bun.which("setsid", trustedLookup);
  const ps = Bun.which("ps", trustedLookup);
  const pkill = Bun.which("pkill", trustedLookup);
  if (setsid === null || ps === null || pkill === null)
    throw new Error("Local terminal panes need setsid, ps and pkill installed");
  const columns = z.number().int().positive().parse(options.columns);
  const rows = z.number().int().positive().parse(options.rows);
  const { env, cwd, command } = await terminalLaunch(options.program);
  const emulator = new Emulator({
    cols: columns,
    rows,
    scrollback: 0,
    allowProposedApi: true,
    logLevel: "off",
  });
  const listeners = new Set<() => void>();
  let retired = false;
  let live = true;
  let exitCode: number | undefined;
  const emit = () => {
    if (!retired) for (const listener of listeners) listener();
  };
  const pty = new Bun.Terminal({
    cols: columns,
    rows,
    data: (_terminal, bytes) => {
      if (!retired) emulator.write(bytes, emit);
    },
  });
  let child: Bun.Subprocess | undefined;
  try {
    child = Bun.spawn([setsid, "--ctty", ...command], {
      terminal: pty,
      cwd,
      env,
    });
    const probe = Bun.spawn([ps, "-o", "sid=", "-p", String(child.pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const session = z.coerce
      .number()
      .int()
      .positive()
      .parse((await new Response(probe.stdout).text()).trim());
    if (session !== child.pid)
      throw new Error(
        "Local shell did not acquire an isolated terminal session",
      );
  } catch (cause) {
    child?.kill();
    pty.close();
    emulator.dispose();
    throw new Error("Local terminal could not start", { cause });
  }
  const processHandle = child;
  let processCleanup: Promise<void> | undefined;
  const terminateSession = () => {
    processCleanup ??= (async () => {
      // Job control creates several groups inside this verified PTY session.
      try {
        await killSessionProcesses(() => {
          const cleanup = Bun.spawn(
            [pkill, "-KILL", "-s", String(processHandle.pid)],
            { stdout: "ignore", stderr: "pipe" },
          );
          return cleanup.exited;
        });
      } finally {
        pty.close();
        processHandle.kill("SIGKILL");
        await processHandle.exited;
        live = false;
      }
    })();
    return processCleanup;
  };
  void processHandle.exited
    .then(async (code) => {
      live = false;
      exitCode = code;
      // Retire the session immediately on shell exit, not a later close using
      // an old PID that the OS may have reused.
      await terminateSession();
      emit();
    })
    .catch((cause: unknown) =>
      reportFailure("local-terminal-exit-cleanup", cause),
    );
  const replies = emulator.onData((data) => {
    if (live && !retired) pty.write(data);
  });
  let close: Promise<void> | undefined;
  let finalFrame: LocalTerminalFrame | undefined;
  const active = () => live && !retired;
  const read = (): LocalTerminalFrame => {
    if (finalFrame !== undefined) return finalFrame;
    const buffer = emulator.buffer.active;
    return {
      cwd,
      live,
      exitCode,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      rows: Array.from({ length: emulator.rows }, (_, y) => {
        const line = buffer.getLine(buffer.viewportY + y);
        return Array.from({ length: emulator.cols }, (_, x) => {
          const cell = line?.getCell(x);
          return {
            text: terminalText(cell?.getChars() ?? "").padEnd(1, " "),
            width: cell?.getWidth() ?? 1,
            foreground:
              cell !== undefined && !cell.isFgDefault()
                ? cellColor(cell.getFgColor(), cell.isFgPalette())
                : undefined,
            background:
              cell !== undefined && !cell.isBgDefault()
                ? cellColor(cell.getBgColor(), cell.isBgPalette())
                : undefined,
            bold: (cell?.isBold() ?? 0) !== 0,
            inverse: (cell?.isInverse() ?? 0) !== 0,
          };
        });
      }),
    };
  };
  return {
    read,
    async hasRunningJobs() {
      if (!active()) return false;
      const probe = Bun.spawn(
        [
          ps,
          "--sid",
          String(processHandle.pid),
          "--no-headers",
          "-o",
          "pid=,stat=",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(probe.stdout).text();
      const code = await probe.exited;
      if (!active()) return false;
      if (code !== 0)
        throw new Error("Local shell jobs could not be inspected");
      const processRow = z.tuple([
        z.coerce.number().int().positive(),
        z.string().min(1).max(16),
      ]);
      return output
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .some((line) => {
          const [pid, state] = processRow.parse(line.trim().split(/\s+/u));
          return pid !== processHandle.pid && !state.startsWith("Z");
        });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    write(input: string) {
      if (live && !retired) pty.write(input);
    },
    paste(input: string) {
      const text = terminalText(input);
      if (live && !retired)
        pty.write(
          emulator.modes.bracketedPasteMode
            ? `\x1b[200~${text}\x1b[201~`
            : text,
        );
    },
    resize(cols: number, nextRows: number) {
      if (retired) return;
      const width = Math.max(1, Math.floor(cols));
      const height = Math.max(1, Math.floor(nextRows));
      emulator.resize(width, height);
      if (live) pty.resize(width, height);
      emit();
    },
    close() {
      close ??= (async () => {
        finalFrame = { ...read(), live: false };
        retired = true;
        listeners.clear();
        replies.dispose();
        try {
          await terminateSession();
        } finally {
          emulator.dispose();
        }
      })();
      return close;
    },
  };
}
