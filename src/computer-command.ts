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

export const computerCommandHelp = `Usage: fungi computer attach <computer> <folder> --fungi-mcp <url> [--yes]
       fungi computer status
       fungi computer detach <computer> --fungi-mcp <url>

Attach a folder on this machine to a Team Computer as one of its execution
backends, then keep it connected until you stop it (Ctrl-C). The Computer's
files and the folder sync both ways; commands routed to this machine run here,
as you, in the folder. Re-run attach to reconnect. Run
fungi login --fungi-mcp <url> first.

      --fungi-mcp <url>          Team MCP endpoint, e.g.
                                 https://<hub>/api/teams/<team>/mcp
      --host-label <label>
                                 Name for this machine (default: hostname)
      --yes                      Accept the access notice without asking
`;

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
        ? `No Computer named ${computer} in this Team.\n`
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
          status.kind === "offline"
            ? `offline (${status.reason}); retrying`
            : status.kind;
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
