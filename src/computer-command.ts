import process from "node:process";
import {
  attachPrivateLocalComputer,
  detachPrivateLocalComputer,
  listPrivateLocalComputers,
  runPrivateLocalComputer,
} from "@fungi.computer/truffle";

/** The Local owners `fungi computer` drives; tests replace them. */
export type ComputerCommandOwners = Readonly<{
  attach: typeof attachPrivateLocalComputer;
  detach: typeof detachPrivateLocalComputer;
  list: typeof listPrivateLocalComputers;
  run: typeof runPrivateLocalComputer;
}>;

export const computerCommandHelp = `Usage: fungi computer list | info <computer> | new [<name>] | start <computer>
       fungi computer stop <computer> | delete <computer> [--yes]
       fungi computer attach <computer> <folder> --fungi-mcp <url> [--yes]
       fungi computer status
       fungi computer detach <computer> --fungi-mcp <url>
       fungi computer ssh <computer> [--fungi-mcp <url>] [-- <ssh args>]
       fungi computer run [--size <size>] [--push <folder>] -- <command>

Attach a folder on this machine to a Computer as one of its execution
backends, then keep it connected until you stop it (Ctrl-C). The Computer's
files and the folder sync both ways; commands routed to this machine run here,
as you, in the folder. Re-run attach to reconnect. For a Hub Team run
fungi login --fungi-mcp <url> first; for your own Oyster run
fungi mcp use <url> --from-file - with its key first.

      --fungi-mcp <url>          Team MCP endpoint, e.g.
                                 https://<hub>/api/teams/<team>/mcp, or your
                                 Oyster's, e.g. https://<oyster>/mcp
      --host-label <label>
                                 Name for this machine (default: hostname)
      --yes                      Accept the notice, or the delete question,
                                 without asking
      --size <size>              With new or run: small, default or large
      --push <folder>            With run: copy this folder into the Computer
      --json                     With list, info, new and start: one JSON
                                 document on stdout

list and info read each Computer's real state without waking it. new creates a
Computer (the Hub names it when you give no name) and retries an unconfirmed
creation without making a second one. start waits for admission and shows the
queue place. stop ends a Computer's runtime and keeps its files. delete erases
the Computer and its files for good: it asks first, and needs --yes without a
terminal. Only a Computer's creator or a Team owner signed in as a person can
stop or delete it. A <computer> is a name or an id.

ssh opens an SSH session on a hosted Team Computer with the system ssh, using a
throwaway key and a 5-minute certificate from the Hub; your own keys and agent
are never offered. Arguments after -- go to ssh (fungi computer ssh home -- ls).

run creates a Computer, copies --push's folder into /workspace, runs the
command there over SSH, then deletes the Computer, even after Ctrl-C or a
failure. In a Git folder only the files Git keeps go (.gitignore applies);
any other folder goes whole. It exits with the command's exit code and prints
how long the Computer was up, its size, and an estimated cost
(fungi computer run --push . -- npm test).
`;

export type OfflineStatus = Readonly<{
  kind: "offline";
  retryInMs: number;
  reason: "unreachable" | "probe-unavailable" | "connection-closed";
}>;

/** One plain sentence for a dropped link; the raw cause stays out of the terminal. */
export function offlineLine(status: OfflineStatus): string {
  const seconds = Math.max(1, Math.round(status.retryInMs / 1000));
  const why =
    status.reason === "connection-closed"
      ? "the connection dropped"
      : status.reason === "probe-unavailable"
        ? "can't check the host (is this machine online?)"
        : "can't reach the host";
  return `offline, ${why}; retrying in ${String(seconds)} s`;
}

export type Write = Readonly<{ write: (text: string) => void }>;
export type Signals = Readonly<{
  on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  off: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
}>;

export type ComputerCommandInput = Readonly<{
  action: "attach" | "status" | "detach";
  computer?: string | undefined;
  folder?: string | undefined;
  endpoint?: string | undefined;
  hostLabel?: string | undefined;
  yes: boolean;
  stdout: Write;
  signals?: Signals | undefined;
  confirm?: ((question: string) => Promise<boolean>) | undefined;
}>;

function accessNotice(computer: string, folder: string): string {
  return `Attaching ${folder} to ${computer}.
Agents and Apps allowed to run commands on ${computer} will be able to run them
on this machine, as you, starting in this folder, with your account's access to
this machine. Their output is not filtered. Files sync both ways between the
folder and the Computer. The Computer wins: if a file is changed or deleted in
both places while this machine is offline, the Computer's version is kept and
your folder's edit is overwritten. Don't edit this folder while it is offline.
Fungi reads no credential stores and passes no environment variables to
those commands beyond the executable search path.
`;
}

/** `fungi computer attach|status|detach`. */
export async function runComputerCommand(
  input: ComputerCommandInput,
  owners: ComputerCommandOwners,
): Promise<void> {
  const { stdout } = input;
  if (input.action === "status") {
    const attached = await owners.list();
    if (attached.length === 0) {
      stdout.write("This machine is not attached to any Computer.\n");
      return;
    }
    for (const entry of attached)
      stdout.write(
        `${entry.computerName} (${entry.computerId}) <- ${entry.rootPath} ${entry.backendId ?? "[attach pending; re-run attach]"}\n`,
      );
    return;
  }
  const { endpoint, computer } = input;
  if (endpoint === undefined)
    throw new Error(`fungi computer ${input.action} requires --fungi-mcp`);
  if (computer === undefined)
    throw new Error(`fungi computer ${input.action} requires a Computer`);
  if (input.action === "detach") {
    const result = await owners.detach(endpoint, computer);
    stdout.write(
      result.kind === "detached"
        ? `Detached this machine from ${computer}. The folder keeps its files.\n`
        : result.kind === "not-attached"
          ? `This machine is not attached to ${computer}.\n`
          : `Detach ${result.kind}; retry fungi computer detach ${computer} --fungi-mcp ${endpoint}.\n`,
    );
    return;
  }
  if (input.folder === undefined)
    throw new Error("fungi computer attach requires a folder");
  stdout.write(accessNotice(computer, input.folder));
  if (!input.yes) {
    if (input.confirm === undefined)
      throw new Error("Re-run with --yes to accept the notice above");
    if (!(await input.confirm("Attach this folder? [y/N] "))) {
      stdout.write("Not attached.\n");
      return;
    }
  }
  const attachInput =
    input.hostLabel === undefined
      ? { computer, folderPath: input.folder }
      : { computer, folderPath: input.folder, hostLabel: input.hostLabel };
  const attached = await owners.attach(endpoint, attachInput);
  if (attached.kind !== "attached") {
    stdout.write(
      attached.kind === "not-found"
        ? `No Computer named ${computer} on that host.\n`
        : `Attach ${attached.kind}; re-run the same command to retry.\n`,
    );
    return;
  }
  stdout.write(
    `Attached ${attached.rootPath} to ${attached.computerName} as ${attached.backendId}. Press Ctrl-C to stop.\n`,
  );
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  const signals = input.signals ?? process;
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  let last = "";
  try {
    const runOptions: Parameters<ComputerCommandOwners["run"]>[2] = {
      signal: controller.signal,
      onStatus: (status) => {
        const line =
          status.kind === "offline" ? offlineLine(status) : status.kind;
        if (line === last) return;
        last = line;
        stdout.write(`${attached.computerName}: ${line}\n`);
      },
    };
    const outcome = await owners.run(endpoint, attached.computerId, runOptions);
    stdout.write(
      outcome === "detached"
        ? `This machine was detached from ${attached.computerName}; Local forgot the attachment.\n`
        : `Stopped. ${attached.computerName} keeps its files; re-run attach to reconnect.\n`,
    );
  } finally {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  }
}
