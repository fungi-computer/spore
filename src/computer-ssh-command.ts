import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type {
  ComputerSshMint,
  mintPrivateComputerSshCertificate,
  pipePrivateComputerSsh,
  startPrivateTeamComputer,
} from "@fungi.computer/truffle";

type ComputerState = Parameters<
  Parameters<typeof startPrivateTeamComputer>[2]["onState"]
>[0];

const missingOpenSsh =
  "fungi computer ssh needs the OpenSSH client (ssh and ssh-keygen) on this machine. Install OpenSSH and retry.";

/** The login the Computer's sshd admits; the Hub's certificate names it. */
const sshUser = "fungi";

export type SshRunner = Readonly<{
  /** Run a native command; "missing" when it is not installed. */
  run: (
    command: string,
    args: readonly string[],
    options: Readonly<{
      env: Readonly<Record<string, string>>;
      /** Share this terminal (ssh) or stay quiet (ssh-keygen). */
      stdio: "inherit" | "ignore";
      signal: AbortSignal;
    }>,
  ) => Promise<number | "missing">;
}>;

/** The real runner; the signal ends the child with SIGTERM. */
export const nativeSshRunner: SshRunner = {
  run: (command, args, options) =>
    new Promise<number | "missing">((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: options.stdio,
        env: { ...options.env },
        signal: options.signal,
        killSignal: "SIGTERM",
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") resolve("missing");
        else if (error.name === "AbortError") resolve(143);
        else reject(error);
      });
      child.once("exit", (code, signal) => {
        resolve(code ?? (signal === null ? 1 : 128));
      });
    }),
};

export type ComputerSshOwners = Readonly<{
  start: typeof startPrivateTeamComputer;
  mint: typeof mintPrivateComputerSshCertificate;
  pipe: typeof pipePrivateComputerSsh;
  runner: SshRunner;
}>;

/** ssh expands % tokens in paths and commands it is given; a literal % is %%. */
function sshPercent(value: string): string {
  return value.replaceAll("%", "%%");
}

// A -o value ssh would split at spaces: double-quoted, with backslash and quote escaped.
function sshQuoted(value: string): string {
  const escaped = sshPercent(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}

/** One argument for the shell ssh runs a ProxyCommand with. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stateLine(name: string, state: ComputerState): string {
  if (state.state === "queued")
    return `${name}: waiting for a machine, #${String(state.position)} in line`;
  if (state.state === "start_failed")
    return `${name}: couldn't start${state.reason === undefined ? "" : `: ${state.reason}`}`;
  return `${name}: ${state.state}`;
}

/** The environment ssh runs in: no agent exists for it to forward or offer. */
function sshEnvironment(env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined ||
      name === "SSH_AUTH_SOCK" ||
      name === "SSH_AGENT_PID"
        ? []
        : [[name, value]],
    ),
  );
}

/**
 * The ssh argv for one run. Every identity option that matters is fixed here,
 * before anything the caller passed: the throwaway key and certificate are the
 * only credentials, no agent or user config is read, the host key is pinned.
 */
function sshArguments(input: {
  directory: string;
  minted: ComputerSshMint;
  proxyCommand: string;
  extra: readonly string[];
}): string[] {
  const { directory, minted } = input;
  return [
    "-F",
    "/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${sshQuoted(join(directory, "known_hosts"))}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `HostKeyAlias=${minted.hostKeyAlias}`,
    "-o",
    `ProxyCommand=${sshPercent(input.proxyCommand)}`,
    "-o",
    "ServerAliveInterval=30",
    "-i",
    sshPercent(join(directory, "key")),
    "-o",
    `CertificateFile=${sshQuoted(join(directory, "key-cert.pub"))}`,
    `${sshUser}@${minted.hostKeyAlias}`,
    ...input.extra,
  ];
}

/** `fungi computer ssh <computer> [-- <ssh args>]`; resolves to ssh's exit code. */
export async function runComputerSshCommand(
  input: {
    computer: string;
    endpoint: string;
    sshArguments: readonly string[];
    /** How this CLI starts itself, for the ProxyCommand ssh runs. */
    selfCommand: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
    stderr: Readonly<{ write: (text: string) => void }>;
    signals?:
      | Readonly<{
          on: (
            signal: "SIGINT" | "SIGTERM" | "SIGHUP",
            listener: () => void,
          ) => void;
          off: (
            signal: "SIGINT" | "SIGTERM" | "SIGHUP",
            listener: () => void,
          ) => void;
        }>
      | undefined;
    temporaryRoot?: string | undefined;
  },
  owners: ComputerSshOwners,
): Promise<number> {
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  const ignore = () => undefined;
  const signals = input.signals ?? process;
  // Ctrl-C reaches ssh through the terminal; the other two end it here. All
  // three still leave through the cleanup below.
  signals.on("SIGINT", ignore);
  signals.on("SIGTERM", stop);
  signals.on("SIGHUP", stop);
  const directory = await mkdtemp(
    join(input.temporaryRoot ?? tmpdir(), "fungi-computer-ssh-"),
  );
  try {
    const name = input.computer;
    const computer = await owners.start(input.endpoint, name, {
      signal: controller.signal,
      onState: (state) => {
        input.stderr.write(`${stateLine(name, state)}\n`);
      },
    });
    const environment = sshEnvironment(input.env);
    const key = join(directory, "key");
    const made = await owners.runner.run(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "fungi-computer-ssh", "-f", key],
      { env: environment, stdio: "ignore", signal: controller.signal },
    );
    if (made === "missing") throw new Error(missingOpenSsh);
    if (made !== 0)
      throw new Error(
        `ssh-keygen could not make the temporary SSH key (exit ${String(made)}).`,
      );
    const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
    const minted = await owners.mint(
      input.endpoint,
      computer.computerId,
      publicKey,
      { signal: controller.signal },
    );
    await writeFile(
      join(directory, "key-cert.pub"),
      `${minted.certificate}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "known_hosts"),
      `${minted.hostKeyAlias} ${minted.hostKey}\n`,
      { mode: 0o600 },
    );
    const proxyCommand = [
      ...input.selfCommand,
      "computer",
      "ssh-proxy",
      computer.computerId,
      "--fungi-mcp",
      input.endpoint,
    ]
      .map(shellQuote)
      .join(" ");
    const code = await owners.runner.run(
      "ssh",
      sshArguments({
        directory,
        minted,
        proxyCommand,
        extra: input.sshArguments,
      }),
      { env: environment, stdio: "inherit", signal: controller.signal },
    );
    if (code === "missing") throw new Error(missingOpenSsh);
    return code;
  } catch (error) {
    if (controller.signal.aborted) {
      input.stderr.write("Stopped.\n");
      return 130;
    }
    throw error;
  } finally {
    signals.off("SIGINT", ignore);
    signals.off("SIGTERM", stop);
    signals.off("SIGHUP", stop);
    await rm(directory, { recursive: true, force: true });
  }
}

/** `fungi computer ssh-proxy <computer>`: ssh's ProxyCommand; 0 after a clean close. */
export async function runComputerSshProxyCommand(
  input: {
    computerId: string;
    endpoint: string;
    stdin: NodeJS.ReadableStream;
    stdout: Pick<NodeJS.WritableStream, "write">;
    stderr: Readonly<{ write: (text: string) => void }>;
    signal?: AbortSignal | undefined;
  },
  owners: Pick<ComputerSshOwners, "pipe">,
): Promise<number> {
  try {
    await owners.pipe(
      input.endpoint,
      input.computerId,
      { input: input.stdin, output: input.stdout },
      input.signal === undefined ? {} : { signal: input.signal },
    );
    return 0;
  } catch (error) {
    input.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
