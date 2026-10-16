import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { binaryPath } from "@opencode-ai/pty";
import { terminalLaunch } from "./local-terminal.js";
import {
  openOwnedPtyTransport,
  type DaemonAttachment,
} from "./opencode-pty-transport.js";
import { reportFailure } from "./log-event.js";

/** One Mac pane owns one daemon and its PTY; closing the pane never detaches it. */
export async function openMacTerminal(
  options: Readonly<{
    columns: number;
    rows: number;
    /** The program the pane runs, when it is not the login shell. */
    program?:
      | Readonly<{
          command: readonly string[];
          cwd: string;
          env: Readonly<Record<string, string>>;
        }>
      | undefined;
  }>,
) {
  if (process.platform !== "darwin")
    throw new Error("Mac terminal panes require macOS");
  const executable = binaryPath;
  if (!executable) throw new Error("Mac terminal PTY binary is unavailable");
  const cols = Math.floor(options.columns);
  const rows = Math.floor(options.rows);
  if (
    !Number.isSafeInteger(cols) ||
    cols < 1 ||
    !Number.isSafeInteger(rows) ||
    rows < 1
  )
    throw new Error("Mac terminal dimensions must be positive integers");
  const launch = await terminalLaunch(options.program);
  const [file, ...args] = launch.command;
  if (!file) throw new Error("Mac terminal launch command is empty");
  const root = await mkdtemp(join(tmpdir(), "fungi-pane-pty-"));
  const scope = await Effect.runPromise(Scope.make());
  let attachment: DaemonAttachment | undefined;
  // Event handlers and renderer attach after the process starts. Raw bytes are
  // replayed before the subscription is activated, so no output is lost.
  const bytes = new Set<(data: Uint8Array) => void>();
  const changes = new Set<() => void>();
  let live = true;
  let exitCode: number | undefined;
  let endFailure: string | undefined;
  let retired = false;
  let closeTask: Promise<void> | undefined;
  const active = () => live && !retired;
  let queue = Promise.resolve();
  const pending = new AbortController();
  let pendingCount = 0;
  let pendingBytes = 0;
  let stop: (() => Promise<void>) | undefined;
  const notify = () => {
    for (const listener of changes) listener();
  };
  const enqueue = (
    work: (signal: AbortSignal) => Promise<void>,
    weight: number,
  ) => {
    // There is one writer and one ordered control/input stream. Do not retain
    // an unbounded backlog while a service request is stalled.
    if (pendingCount + 1 > 128 || pendingBytes + weight > 256 * 1024) {
      reportFailure(
        "mac-terminal-input-refused",
        new Error("Mac PTY input backlog exceeded"),
      );
      return false;
    }
    pendingCount += 1;
    pendingBytes += weight;
    queue = queue
      .then(() => (retired ? undefined : work(pending.signal)))
      .then(
        () => undefined,
        (cause: unknown) => {
          if (!retired) {
            reportFailure("mac-terminal-pty", cause);
            live = false;
            notify();
            void stop?.().catch((error: unknown) => {
              reportFailure("mac-terminal-close-after-error", error);
            });
          }
          return undefined;
        },
      )
      .finally(() => {
        pendingCount -= 1;
        pendingBytes -= weight;
      });
    return true;
  };
  try {
    const daemon = await Effect.runPromise(
      openOwnedPtyTransport(root, "pane", () =>
        Promise.resolve(executable),
      ).pipe(Scope.provide(scope)),
    );
    const created = await Effect.runPromise(
      daemon.request(
        {
          op: "create",
          program: file,
          args,
          cwd: launch.cwd,
          title:
            options.program === undefined ? "Local shell" : "Installed program",
          group_id: "local-pane",
          env: Object.fromEntries(
            Object.entries(launch.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          cols,
          rows,
        },
        true,
      ),
    );
    if (created.type !== "created")
      throw new Error("Mac PTY did not create a terminal");
    const id = created.terminal.id;
    const pid = created.terminal.pid;
    let size = { cols, rows };
    attachment = await Effect.runPromise(
      daemon.subscribe(id, {
        cursor: 0,
        attachmentID: "pane-controller",
        role: "controller",
        onEvent: (event) => {
          if (retired) return;
          if (event.type === "output")
            for (const listener of bytes) listener(event.data);
          if (event.type === "exited") {
            live = false;
            exitCode = event.exitCode;
            notify();
          }
        },
        onEnd: (failure) => {
          if (!retired) {
            live = false;
            endFailure = failure?.message;
            notify();
          }
        },
      }),
    );
    if (attachment.role !== "controller")
      throw new Error("Mac PTY pane did not acquire controller role");
    const replay = attachment.replay.data;
    // Activation starts the live pump; replay is delivered to the first view on
    // subscription, not interpreted as a second terminal or a text snapshot.
    let initial = replay;
    let activated = false;
    const opened = {
      cwd: launch.cwd,
      get live() {
        return live;
      },
      get exitCode() {
        return exitCode;
      },
      get failure() {
        return endFailure;
      },
      subscribe(listener: () => void) {
        changes.add(listener);
        return () => {
          changes.delete(listener);
        };
      },
      onBytes(listener: (data: Uint8Array) => void) {
        bytes.add(listener);
        if (initial.byteLength) {
          listener(initial);
          initial = new Uint8Array();
        }
        if (!activated) {
          activated = true;
          attachment?.activate();
        }
        return () => {
          bytes.delete(listener);
        };
      },
      input(data: Uint8Array) {
        if (!live || retired) return false;
        if (!data.byteLength) return true;
        if (data.byteLength > 256 * 1024) {
          reportFailure(
            "mac-terminal-input-refused",
            new Error("Mac PTY input exceeds one bounded request"),
          );
          return false;
        }
        const encoded = Buffer.from(data).toString("base64");
        const dimensions = size;
        return enqueue(async (signal) => {
          await Effect.runPromise(
            daemon.request({
              op: "input",
              id,
              attachment_id: "pane-controller",
              cols: dimensions.cols,
              rows: dimensions.rows,
              data_base64: encoded,
            }),
            { signal },
          );
        }, data.byteLength);
      },
      resize(cols: number, rows: number) {
        if (retired || !live) return false;
        const width = Math.max(1, Math.floor(cols));
        const height = Math.max(1, Math.floor(rows));
        if (width === size.cols && height === size.rows) return true;
        const accepted = enqueue(async (signal) => {
          await Effect.runPromise(
            daemon.request({
              op: "control",
              id,
              attachment_id: "pane-controller",
              cols: width,
              rows: height,
            }),
            { signal },
          );
        }, 0);
        if (accepted) size = { cols: width, rows: height };
        return accepted;
      },
      async hasRunningJobs() {
        if (!active() || pid === null) return false;
        // pgrep's -P targets only the exact live child returned by this
        // daemon. -q reports presence by exit code, without a machine-wide
        // process snapshot or a ps-output parser.
        const probe = Bun.spawn(["/usr/bin/pgrep", "-q", "-P", String(pid)], {
          stdout: "ignore",
          stderr: "ignore",
          timeout: 3000,
        });
        const code = await probe.exited;
        if (!active()) return false;
        if (code === 0) return true;
        if (code === 1) return false;
        throw new Error(
          `Mac shell jobs could not be inspected (${String(code)})`,
        );
      },
      close() {
        closeTask ??= (async () => {
          retired = true;
          pending.abort();
          attachment?.detach();
          bytes.clear();
          changes.clear();
          let shutdownFailure: unknown;
          try {
            await Effect.runPromise(daemon.shutdown);
          } catch (cause) {
            shutdownFailure = cause;
          } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void));
            live = false;
          }
          // Even if the explicit request failed, dropping the sole owner socket
          // terminates the daemon. Confirm that it actually removed its private
          // registration before deleting this pane's runtime directory.
          let stopped = false;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const directories = await readdir(root, { withFileTypes: true });
            const registrations = await Promise.all(
              directories
                .filter((entry) => entry.isDirectory())
                .map((entry) =>
                  stat(join(root, entry.name, "service.json")).then(
                    () => true,
                    (cause: unknown) => {
                      if (
                        cause instanceof Error &&
                        "code" in cause &&
                        cause.code === "ENOENT"
                      )
                        return false;
                      throw cause;
                    },
                  ),
                ),
            );
            if (!registrations.includes(true)) {
              stopped = true;
              break;
            }
            await Bun.sleep(25);
          }
          if (!stopped)
            throw new Error(
              "Mac PTY owner closed but daemon still registered",
              {
                cause: shutdownFailure,
              },
            );
          if (shutdownFailure !== undefined)
            reportFailure("mac-terminal-shutdown-fallback", shutdownFailure);
          await rm(root, { recursive: true, force: true });
        })();
        return closeTask;
      },
    };
    stop = () => opened.close();
    return opened;
  } catch (cause) {
    attachment?.detach();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(root, { recursive: true, force: true });
    throw new Error("Mac terminal could not start", { cause });
  }
}
