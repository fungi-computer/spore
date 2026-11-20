import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { afterEach, expect, test } from "bun:test";
import {
  runComputerSshCommand,
  runComputerSshProxyCommand,
  type ComputerSshOwners,
  type SshRunner,
} from "../src/computer-ssh-command.js";
import { runFungiCli } from "../src/cli.js";

const endpoint = "https://hub.test/api/teams/team-1/mcp";
// Random per run: a literal key-shaped string would trip the secret scan.
const blob = () => randomBytes(24).toString("base64");
const privateKeyText = `-----BEGIN PRIVATE KEY----- PRIVATE-KEY-MARKER ${blob()}`;
const publicKeyText = `ssh-ed25519 ${blob()} fungi-computer-ssh`;
const minted = {
  certificate: `ssh-ed25519-cert-v01@openssh.com ${blob()} user:u team:t`,
  hostKey: `ssh-ed25519 ${blob()}`,
  hostKeyAlias: "computer_1.computer.fungi",
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type Call = {
  command: string;
  args: string[];
  stdio: string;
  env: Record<string, string>;
};

/** ssh reads %% as one literal %. */
const unpercent = (value: string) => value.replaceAll("%%", "%");

/**
 * Fake ssh-keygen and ssh: records argv, writes a key pair where ssh-keygen is
 * told to, and snapshots the temporary directory while ssh "runs".
 */
function fakeSsh(options: {
  missing?: "ssh" | "ssh-keygen";
  hold?: boolean;
  exit?: number;
}) {
  const calls: Call[] = [];
  const inputs: (NodeJS.ReadableStream | undefined)[] = [];
  const snapshots: {
    mode: number;
    files: Record<string, string>;
    directory: string;
  }[] = [];
  const runner: SshRunner = {
    run: async (command, args, run) => {
      calls.push({
        command,
        args: [...args],
        stdio: run.stdio,
        env: { ...run.env },
      });
      inputs.push(run.stdin);
      if (options.missing === command) return "missing";
      if (command === "ssh-keygen") {
        const key = args[args.indexOf("-f") + 1] ?? "";
        await writeFile(key, `${privateKeyText}\n`, { mode: 0o600 });
        await writeFile(`${key}.pub`, `${publicKeyText}\n`);
        return 0;
      }
      const key = unpercent(args[args.indexOf("-i") + 1] ?? "");
      const directory = dirname(key);
      snapshots.push({
        directory,
        mode: (await stat(directory)).mode & 0o777,
        files: {
          known_hosts: await readFile(join(directory, "known_hosts"), "utf8"),
          cert: await readFile(join(directory, "key-cert.pub"), "utf8"),
        },
      });
      if (options.hold)
        await new Promise<void>((resolve) => {
          run.signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      return run.signal.aborted ? 143 : (options.exit ?? 0);
    },
  };
  return { calls, inputs, snapshots, runner };
}

function fakeOwners(runner: SshRunner) {
  const seen: unknown[] = [];
  const owners: ComputerSshOwners = {
    start: (endpoint, name, options) => {
      seen.push(["start", endpoint, name]);
      options.onState({ state: "starting" });
      return Promise.resolve({ computerId: "computer_1", name });
    },
    mint: (endpoint, computerId, publicKey) => {
      seen.push(["mint", endpoint, computerId, publicKey]);
      return Promise.resolve(minted);
    },
    pipe: () => Promise.resolve(),
    runner,
  };
  return { owners, seen };
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "fungi-ssh-command-test-"));
  roots.push(root);
  return root;
}

function signalsFake() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    signals: {
      on: (signal: string, listener: () => void) => {
        handlers.set(signal, (handlers.get(signal) ?? new Set()).add(listener));
      },
      off: (signal: string, listener: () => void) => {
        handlers.get(signal)?.delete(listener);
      },
    },
    emit: (signal: string) => {
      for (const listener of handlers.get(signal) ?? []) listener();
    },
    listening: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  };
}

function input(
  root: string,
  extra: Partial<Parameters<typeof runComputerSshCommand>[0]> = {},
) {
  let errors = "";
  return {
    errors: () => errors,
    value: {
      computer: "home",
      endpoint,
      sshArguments: [],
      selfCommand: ["/opt/fungi/bun", "/opt/fungi/cli.js"],
      env: {
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        SSH_AGENT_PID: "42",
        HOME: "/home/me",
      },
      stderr: {
        write: (text: string) => {
          errors += text;
        },
      },
      temporaryRoot: root,
      ...extra,
    },
  };
}

test("fungi computer ssh runs ssh with the pinned, agentless argv and a throwaway key", async () => {
  const root = await temporaryRoot();
  const ssh = fakeSsh({});
  const { owners, seen } = fakeOwners(ssh.runner);
  const run = input(root, { sshArguments: ["echo", "ok"] });
  const code = await runComputerSshCommand(run.value, owners);
  expect(code).toBe(0);
  const [keygen, connect] = ssh.calls;
  assert.ok(keygen !== undefined && connect !== undefined);
  expect(keygen.command).toBe("ssh-keygen");
  expect(keygen.args.slice(0, 7)).toEqual([
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "fungi-computer-ssh",
  ]);
  const directory = dirname(
    unpercent(connect.args[connect.args.indexOf("-i") + 1] ?? ""),
  );
  expect(keygen.args.at(-1)).toBe(join(directory, "key"));
  expect(connect.command).toBe("ssh");
  expect(connect.stdio).toBe("inherit");
  expect(connect.args).toEqual([
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
    `UserKnownHostsFile="${join(directory, "known_hosts")}"`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "HostKeyAlias=computer_1.computer.fungi",
    "-o",
    `ProxyCommand='/opt/fungi/bun' '/opt/fungi/cli.js' 'computer' 'ssh-proxy' 'computer_1' '--fungi-mcp' '${endpoint}'`,
    "-o",
    "ServerAliveInterval=30",
    "-i",
    join(directory, "key"),
    "-o",
    `CertificateFile="${join(directory, "key-cert.pub")}"`,
    "fungi@computer_1.computer.fungi",
    "echo",
    "ok",
  ]);
  // No agent exists in ssh's environment for it to offer or forward.
  expect(connect.env.SSH_AUTH_SOCK).toBeUndefined();
  expect(connect.env.SSH_AGENT_PID).toBeUndefined();
  expect(connect.env.PATH).toBe("/usr/bin");
  // The Hub sees the public key alone, for the resolved Computer id.
  expect(seen).toEqual([
    ["start", endpoint, "home"],
    ["mint", endpoint, "computer_1", publicKeyText],
  ]);
  expect(JSON.stringify([seen, ssh.calls])).not.toContain("PRIVATE-KEY-MARKER");
  // The host key is pinned to the Hub's answer, under the alias ssh is told.
  const [snapshot] = ssh.snapshots;
  assert.ok(snapshot !== undefined);
  expect(snapshot.mode).toBe(0o700);
  expect(snapshot.files.known_hosts).toBe(
    `${minted.hostKeyAlias} ${minted.hostKey}\n`,
  );
  expect(snapshot.files.cert).toBe(`${minted.certificate}\n`);
  expect(run.errors()).toContain("home: starting");
  // The key, certificate and known_hosts are gone once ssh exits.
  await assert.rejects(stat(directory));
});

test("the temporary key directory is removed after ssh fails, and ssh's exit code is returned", async () => {
  const root = await temporaryRoot();
  const ssh = fakeSsh({ exit: 255 });
  const { owners } = fakeOwners(ssh.runner);
  expect(await runComputerSshCommand(input(root).value, owners)).toBe(255);
  const directory = dirname(
    unpercent(ssh.calls[1]?.args[ssh.calls[1].args.indexOf("-i") + 1] ?? ""),
  );
  await assert.rejects(stat(directory));
});

test("SIGTERM ends ssh and removes the key; SIGINT is left to ssh and its terminal", async () => {
  const root = await temporaryRoot();
  const ssh = fakeSsh({ hold: true });
  const { owners } = fakeOwners(ssh.runner);
  const fake = signalsFake();
  const running = runComputerSshCommand(
    input(root, { signals: fake.signals }).value,
    owners,
  );
  while (ssh.snapshots.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  fake.emit("SIGINT");
  expect(ssh.snapshots).toHaveLength(1);
  const directory = ssh.snapshots[0]?.directory ?? "";
  await stat(directory);
  fake.emit("SIGTERM");
  expect(await running).toBe(143);
  await assert.rejects(stat(directory));
  expect(fake.listening()).toBe(0);
});

test("a missing ssh-keygen or ssh names the OpenSSH client in one sentence", async () => {
  for (const missing of ["ssh-keygen", "ssh"] as const) {
    const root = await temporaryRoot();
    const { owners } = fakeOwners(fakeSsh({ missing }).runner);
    await assert.rejects(runComputerSshCommand(input(root).value, owners), {
      message:
        "fungi computer ssh needs the OpenSSH client (ssh and ssh-keygen) on this machine. Install OpenSSH and retry.",
    });
  }
});

test("a refused certificate leaves nothing behind and the Hub's sentence reaches the person", async () => {
  const root = await temporaryRoot();
  const ssh = fakeSsh({});
  const { owners } = fakeOwners(ssh.runner);
  await assert.rejects(
    runComputerSshCommand(input(root).value, {
      ...owners,
      mint: () =>
        Promise.reject(
          new Error("You can't get an SSH certificate on this Computer."),
        ),
    }),
    { message: "You can't get an SSH certificate on this Computer." },
  );
  expect(ssh.calls.map((call) => call.command)).toEqual(["ssh-keygen"]);
  expect(await readdir(root)).toEqual([]);
});

test("ssh-proxy reports a Hub refusal on stderr with a failing exit and a clean close with 0", async () => {
  let errors = "";
  const base = {
    computerId: "computer_1",
    endpoint,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: {
      write: (text: string) => {
        errors += text;
      },
    },
  };
  expect(
    await runComputerSshProxyCommand(base, { pipe: () => Promise.resolve() }),
  ).toBe(0);
  expect(
    await runComputerSshProxyCommand(base, {
      pipe: () =>
        Promise.reject(new Error("The Hub has no such Computer in this Team.")),
    }),
  ).toBe(1);
  expect(errors).toBe("The Hub has no such Computer in this Team.\n");
});

test("fungi computer ssh takes ssh's own arguments after --", async () => {
  const ssh = fakeSsh({});
  const { owners } = fakeOwners(ssh.runner);
  const original = process.env.FUNGI_BUNDLED_CLI;
  process.env.FUNGI_BUNDLED_CLI = "/opt/fungi/cli.js";
  try {
    await runFungiCli(
      [
        "computer",
        "ssh",
        "home",
        "--fungi-mcp",
        endpoint,
        "--",
        "-L",
        "8080:localhost:8080",
        "ls",
      ],
      { stderr: { write: () => true } },
      { computerSshOwners: owners },
    );
  } finally {
    if (original === undefined) delete process.env.FUNGI_BUNDLED_CLI;
    else process.env.FUNGI_BUNDLED_CLI = original;
  }
  const connect = ssh.calls.find((call) => call.command === "ssh");
  expect(connect?.args.slice(-4)).toEqual([
    "fungi@computer_1.computer.fungi",
    "-L",
    "8080:localhost:8080",
    "ls",
  ]);
  expect(connect?.args.join(" ")).toContain(
    `computer' 'ssh-proxy' 'computer_1' '--fungi-mcp' '${endpoint}'`,
  );
});

test("a space, quote or percent in the temp directory or endpoint cannot split or expand ssh's options", async () => {
  const base = await temporaryRoot();
  const root = join(base, 'my dir "q" %h %d');
  await mkdir(root);
  const odd = "https://hub.test/api/teams/team%2D1/mcp";
  const ssh = fakeSsh({});
  const { owners } = fakeOwners(ssh.runner);
  await runComputerSshCommand({ ...input(root).value, endpoint: odd }, owners);
  const connect = ssh.calls[1];
  assert.ok(connect !== undefined);
  const snapshot = ssh.snapshots[0];
  assert.ok(snapshot !== undefined);
  // The fake read the key, certificate and known_hosts at the real, unescaped path.
  expect(snapshot.directory.startsWith(root)).toBe(true);
  const escaped = snapshot.directory
    .replaceAll("%", "%%")
    .replaceAll('"', '\\"');
  const options = connect.args.filter(
    (_, index) => connect.args[index - 1] === "-o",
  );
  // Each path option is one double-quoted value with % doubled and " escaped.
  expect(options).toContain(`UserKnownHostsFile="${escaped}/known_hosts"`);
  expect(options).toContain(`CertificateFile="${escaped}/key-cert.pub"`);
  // The identity file is one argv entry with its % doubled.
  expect(connect.args).toContain(
    `${snapshot.directory.replaceAll("%", "%%")}/key`,
  );
  // The ProxyCommand's % (here in the endpoint) is doubled too.
  const proxy = options.find((option) => option.startsWith("ProxyCommand="));
  expect(proxy).toContain("team%%2D1");
  expect(proxy).not.toMatch(/(?<!%)%(?!%)/u);
  await assert.rejects(stat(snapshot.directory));
});

test("a caller's stream reaches ssh as its input, and the caller's signal ends ssh", async () => {
  const root = await temporaryRoot();
  const fed = fakeSsh({});
  const archive = new PassThrough();
  expect(
    await runComputerSshCommand(
      input(root, { sshArguments: ["tar -x"], stdin: archive }).value,
      fakeOwners(fed.runner).owners,
    ),
  ).toBe(0);
  expect(fed.inputs).toEqual([undefined, archive]);

  const held = fakeSsh({ hold: true });
  const controller = new AbortController();
  const run = input(root, { signal: controller.signal });
  const session = runComputerSshCommand(
    run.value,
    fakeOwners(held.runner).owners,
  );
  while (held.snapshots.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  // As SIGTERM does: ssh is ended and its own exit code comes back.
  expect(await session).toBe(143);
});
