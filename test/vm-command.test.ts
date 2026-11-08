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

/** Fake limactl/ssh: records argv and keeps one instance's Lima status. */
function fakeLima(initial?: string, missing = false) {
  const calls: string[][] = [];
  let status = initial;
  const runner: VmRunner = {
    capture: (command, args) => {
      calls.push([command, ...args]);
      if (missing) return Promise.reject(new Error("fungi vm needs Lima."));
      return Promise.resolve(
        status === undefined
          ? ""
          : `${JSON.stringify({ name: current, status, sshConfigFile: "/lima/ssh.config" })}\n`,
      );
    },
    run: (command, args) => {
      calls.push([command, ...args]);
      if (missing) return Promise.resolve("missing");
      if (command === "limactl" && args[0] === "start") status = "Running";
      if (command === "limactl" && args[0] === "stop") status = "Stopped";
      return Promise.resolve(0);
    },
  };
  let current = "";
  return {
    calls,
    runner,
    named: (name: string) => {
      current = name;
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

test("fungi vm creates the VM with only this folder mounted, then opens fungi in it", async () => {
  const cwd = await project();
  const lima = fakeLima();
  const output = await vm(["--yolo"], cwd, lima);
  const name = vmInstanceName(cwd);
  expect(lima.calls.filter(([, action]) => action !== "list")).toEqual([
    [
      "limactl",
      "start",
      `--name=${name}`,
      `--mount-only=${cwd}:w`,
      `--param=SPORE_VERSION=${sporeVersion}`,
      "--tty=false",
      fungiVmTemplate,
    ],
    ["limactl", "shell", `--workdir=${cwd}`, name, "fungi", "--full-access"],
  ]);
  expect(output).toContain(
    "The agent can change and run anything in this project folder and reach the internet.",
  );
});

test("fungi vm starts a stopped VM and never recreates it", async () => {
  const cwd = await project();
  const lima = fakeLima("Stopped");
  await vm(["--template", "./custom.yaml"], cwd, lima);
  const name = vmInstanceName(cwd);
  expect(lima.calls.filter(([, action]) => action !== "list")).toEqual([
    ["limactl", "start", "--tty=false", name],
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
  await assert.rejects(vm([], cwd, fakeLima(undefined, true)), {
    message: /fungi vm needs Lima/u,
  });
});

test("the default template ships inside Spore with no home mount", async () => {
  const template = await Bun.file(fungiVmTemplate).text();
  expect(template).toContain("mounts: []");
  expect(template).not.toContain("- template:_default/mounts");
});
