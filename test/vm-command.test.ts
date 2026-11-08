import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { runFungiCli } from "../src/cli.js";
import {
  fungiVmTemplate,
  vmInstanceName,
  type VmRunner,
} from "../src/vm-command.js";

const sporeVersion = z
  .object({ version: z.string() })
  .parse(
    await Bun.file(new URL("../package.json", import.meta.url)).json(),
  ).version;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function project(folder = "My Project") {
  const root = await mkdtemp(join(tmpdir(), "fungi-vm-"));
  roots.push(root);
  const path = join(root, folder);
  await Bun.write(join(path, "README.md"), "hi\n");
  return realpath(path);
}

type FakeOptions = Readonly<{
  missing?: boolean;
  kvm?: boolean;
  /** Make `limactl start` fail, leaving a Broken instance in this folder. */
  failStartIn?: string;
  /** This computer's global Git config. */
  git?: Readonly<Record<string, string>>;
  /** Ports the existing instance already forwards. */
  forwarded?: readonly number[];
}>;

/**
 * Fake limactl/ssh: records argv and keeps each instance's Lima status. The
 * project's instance starts in `initial`; others (the base) appear as created.
 */
function fakeLima(initial?: string, options: FakeOptions = {}) {
  const calls: string[][] = [];
  const statuses = new Map<string, string>();
  let current = "";
  const target = (args: readonly string[]) => {
    const flagged = args.find((arg) => arg.startsWith("--name="));
    return flagged?.slice("--name=".length) ?? args.at(-1) ?? "";
  };
  const run = (command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    if (options.missing) return Promise.resolve("missing" as const);
    if (command !== "limactl") return Promise.resolve(0);
    const [action] = args;
    if (action === "start") {
      if (options.failStartIn !== undefined) {
        statuses.set(target(args), "Broken");
        return Promise.resolve(1);
      }
      statuses.set(target(args), "Running");
    }
    if (action === "clone") statuses.set(args.at(-1) ?? "", "Stopped");
    if (action === "stop") statuses.set(target(args), "Stopped");
    if (action === "delete") statuses.delete(target(args));
    return Promise.resolve(0);
  };
  const runner: VmRunner = {
    capture: (command, args) => {
      calls.push([command, ...args]);
      if (command === "git") {
        return Promise.resolve(`${options.git?.[args.at(-1) ?? ""] ?? ""}\n`);
      }
      if (options.missing)
        return Promise.reject(new Error("fungi vm needs Lima."));
      return Promise.resolve(
        [...statuses]
          .map(
            ([name, status]) =>
              `${JSON.stringify({
                name,
                status,
                dir: options.failStartIn,
                sshConfigFile: "/lima/ssh.config",
                config: {
                  portForwards: (name === current
                    ? (options.forwarded ?? [])
                    : []
                  ).map((guestPort) => ({ guestPort })),
                },
              })}\n`,
          )
          .join(""),
      );
    },
    run,
    runLogged: (command, args) => run(command, args),
    kvmUsable: () => Promise.resolve(options.kvm ?? true),
  };
  return {
    calls,
    runner,
    statuses,
    named: (name: string) => {
      current = name;
      if (initial !== undefined) statuses.set(name, initial);
    },
  };
}

async function vm(
  argv: readonly string[],
  cwd: string,
  lima: ReturnType<typeof fakeLima>,
) {
  let output = "";
  lima.named(vmInstanceName(cwd));
  await runFungiCli(
    ["vm", ...argv],
    {
      cwd,
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
      },
    },
    { vmRunner: lima.runner },
  );
  return output;
}

test("instance names are stable per project path and valid for Lima", () => {
  const name = vmInstanceName("/Users/me/src/My Project!");
  expect(name).toMatch(/^fungi-my-project-[0-9a-f]{6}$/u);
  expect(vmInstanceName("/Users/me/src/My Project!")).toBe(name);
  expect(vmInstanceName("/elsewhere/My Project!")).not.toBe(name);
});

test("fungi vm prepares one base VM, clones it with only this folder mounted, then opens fungi", async () => {
  const cwd = await project();
  const lima = fakeLima();
  const output = await vm(["--yolo"], cwd, lima);
  const name = vmInstanceName(cwd);
  const lifecycle = lima.calls.filter(
    ([command, action]) =>
      command === "limactl" && action !== "list" && action !== "shell",
  );
  const base =
    lifecycle[0]?.find((arg) => arg.startsWith("--name="))?.slice(7) ?? "";
  expect(base).toMatch(/^fungi-base-[0-9a-f]{10}$/u);
  expect(lifecycle).toEqual([
    [
      "limactl",
      "start",
      "--log-format=json",
      `--name=${base}`,
      "--mount-none",
      `--param=SPORE_VERSION=${sporeVersion}`,
      "--tty=false",
      fungiVmTemplate,
    ],
    ["limactl", "stop", base],
    ["limactl", "clone", "--tty=false", `--mount-only=${cwd}:w`, base, name],
    ["limactl", "start", "--log-format=json", "--tty=false", name],
  ]);
  expect(lima.calls.at(-1)).toEqual([
    "limactl",
    "shell",
    `--workdir=${cwd}`,
    name,
    "fungi",
    "--full-access",
  ]);
  expect(output).toContain(
    "The agent can change and run anything in this project folder and reach the internet.",
  );

  // A second project reuses the stopped base: one clone and one start.
  const other = await project("Other");
  const before = lima.calls.length;
  const again = await vm([], other, lima);
  expect(again).not.toContain("Preparing the base VM");
  expect(
    lima.calls
      .slice(before)
      .filter(([, action]) => action === "start" || action === "clone")
      .map(([, action, ...rest]) => [action, rest.at(-1)]),
  ).toEqual([
    ["clone", vmInstanceName(other)],
    ["start", vmInstanceName(other)],
  ]);
});

test("a custom --template creates the VM directly, without the base", async () => {
  const cwd = await project();
  const lima = fakeLima();
  await vm(["--template", "./custom.yaml"], cwd, lima);
  expect(lima.calls.find(([, action]) => action === "start")).toEqual([
    "limactl",
    "start",
    "--log-format=json",
    `--name=${vmInstanceName(cwd)}`,
    `--mount-only=${cwd}:w`,
    `--param=SPORE_VERSION=${sporeVersion}`,
    "--tty=false",
    "./custom.yaml",
  ]);
  expect(lima.calls.some(([, action]) => action === "clone")).toBe(false);
});

test("fungi vm starts a stopped VM and never recreates it", async () => {
  const cwd = await project();
  const lima = fakeLima("Stopped");
  await vm(["--template", "./custom.yaml"], cwd, lima);
  const name = vmInstanceName(cwd);
  expect(
    lima.calls.filter(
      ([command, action]) => command === "limactl" && action !== "list",
    ),
  ).toEqual([
    ["limactl", "start", "--log-format=json", "--tty=false", name],
    ["limactl", "shell", `--workdir=${cwd}`, name, "fungi"],
  ]);
});

test("fungi vm login forwards 1455 only for the login", async () => {
  const cwd = await project();
  const lima = fakeLima("Running");
  await vm(["login"], cwd, lima);
  expect(lima.calls.at(-1)).toEqual([
    "ssh",
    "-F",
    "/lima/ssh.config",
    "-t",
    "-L",
    "127.0.0.1:1455:127.0.0.1:1455",
    `lima-${vmInstanceName(cwd)}`,
    "fungi",
    "login",
  ]);
});

test("fungi vm rm refuses a running VM and deletes a stopped one only with --yes", async () => {
  const cwd = await project();
  const running = fakeLima("Running");
  await assert.rejects(vm(["rm", "--yes"], cwd, running), {
    message: /Stop it first: fungi vm stop/u,
  });
  const stopped = fakeLima("Stopped");
  await assert.rejects(vm(["rm"], cwd, stopped), {
    message: /fungi vm rm needs --yes without a terminal/u,
  });
  await vm(["rm", "--yes"], cwd, stopped);
  expect(stopped.calls.at(-1)).toEqual([
    "limactl",
    "delete",
    vmInstanceName(cwd),
  ]);
});

test("fungi vm stop uses Lima's stop and reports an absent VM", async () => {
  const cwd = await project();
  const lima = fakeLima("Running");
  await vm(["stop"], cwd, lima);
  expect(lima.calls.at(-1)).toEqual(["limactl", "stop", vmInstanceName(cwd)]);
  expect(await vm(["stop"], cwd, fakeLima())).toContain(
    "No VM for this folder",
  );
});

test("fungi vm without Lima prints how to install it", async () => {
  const cwd = await project();
  await assert.rejects(vm([], cwd, fakeLima(undefined, { missing: true })), {
    message: /fungi vm needs Lima/u,
  });
});

test("the default template ships inside Spore with no home mount", async () => {
  const template = await Bun.file(fungiVmTemplate).text();
  expect(template).toContain("mounts: []");
  expect(template).not.toContain("- template:_default/mounts");
});

test("fungi vm says plainly when this user cannot use /dev/kvm", async () => {
  const cwd = await project();
  const lima = fakeLima(undefined, { kvm: false });
  await assert.rejects(vm([], cwd, lima), {
    message:
      "Your user can't use /dev/kvm yet: add yourself to the kvm group (sudo usermod -aG kvm $USER) and log in again.",
  });
  expect(lima.calls.some(([, action]) => action === "start")).toBe(false);
});

test("a failed first start names Lima's cause and removes the half-created VM", async () => {
  const cwd = await project();
  const instanceDir = await mkdtemp(join(tmpdir(), "fungi-vm-instance-"));
  roots.push(instanceDir);
  await Bun.write(
    join(instanceDir, "ha.stderr.log"),
    `${JSON.stringify({ level: "info", msg: "Starting QEMU" })}\n${JSON.stringify({ level: "fatal", msg: "Could not access KVM kernel module: Permission denied" })}\n`,
  );
  const lima = fakeLima(undefined, { failStartIn: instanceDir });
  await assert.rejects(vm(["--template", "./custom.yaml"], cwd, lima), {
    message:
      /Could not access KVM kernel module: Permission denied\. Removed the half-created/u,
  });
  expect(lima.calls.at(-1)).toEqual([
    "limactl",
    "delete",
    "--force",
    vmInstanceName(cwd),
  ]);
});

test("fungi vm --port forwards on create and adds a missing port to a stopped VM", async () => {
  const cwd = await project();
  const name = vmInstanceName(cwd);
  const fresh = fakeLima();
  await vm(["--port", "5173", "--port", "3000"], cwd, fresh);
  expect(fresh.calls.find(([, action]) => action === "clone")).toContain(
    '--set=.portForwards = [{"guestPort":5173,"hostPort":5173},{"guestPort":3000,"hostPort":3000}] + .portForwards',
  );
  const stopped = fakeLima("Stopped", { forwarded: [5173] });
  await vm(["--port", "5173", "--port", "8080"], cwd, stopped);
  expect(stopped.calls.find(([, action]) => action === "edit")).toEqual([
    "limactl",
    "edit",
    "--tty=false",
    name,
    '--set=.portForwards = [{"guestPort":8080,"hostPort":8080}] + .portForwards',
  ]);
  await assert.rejects(vm(["--port", "9000"], cwd, fakeLima("Running")), {
    message: /running without port 9000\. Stop it first/u,
  });
  await assert.rejects(vm(["--port", "70000"], cwd, fakeLima()), {
    message: "--port takes a port number from 1 to 65535, not 70000",
  });
});

test("a new VM gets this computer's Git name and email", async () => {
  const cwd = await project();
  const name = vmInstanceName(cwd);
  const lima = fakeLima(undefined, {
    git: { "user.name": "Ada Lovelace", "user.email": "ada@example.test" },
  });
  await vm([], cwd, lima);
  expect(
    lima.calls.filter(
      ([, action, , , tool]) => action === "shell" && tool === "git",
    ),
  ).toEqual([
    [
      "limactl",
      "shell",
      "--workdir=/",
      name,
      "git",
      "config",
      "--global",
      "user.name",
      "Ada Lovelace",
    ],
    [
      "limactl",
      "shell",
      "--workdir=/",
      name,
      "git",
      "config",
      "--global",
      "user.email",
      "ada@example.test",
    ],
  ]);
});
