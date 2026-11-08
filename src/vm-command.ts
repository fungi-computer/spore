import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";

export const vmCommandHelp = `Usage: fungi vm [--yolo|--workspace|--read-only] [--template <file|url>]
       fungi vm login
       fungi vm stop
       fungi vm rm [--yes]

Open Shiitake in a Lima Linux VM that mounts only this project folder. The
first run creates the VM from Fungi's Lima template; later runs start it again
and open fungi inside it, in this folder. The agent can change and run
anything in this project folder and reach the internet. Your home folder and
SSH keys are not mounted. Needs Lima: brew install lima on macOS, or
https://lima-vm.io/docs/installation/ on Linux.

  login      Run fungi login in the VM, forwarding port 1455 while it runs
             so a ChatGPT browser sign-in can finish
  stop       Stop the VM; its disk, tools and logins are kept
  rm         Delete a stopped VM and its disk; the project folder stays

      --template <file|url>      Lima template for a new VM (default: Fungi's)
      --yes                      Delete without asking
`;

export const fungiVmTemplate = "https://docs.fungi.computer/lima/fungi-vm.yaml";

/** One native command; resolves with its exit code, or "missing" for ENOENT. */
export type VmRunner = Readonly<{
  run: (
    command: string,
    args: readonly string[],
  ) => Promise<number | "missing">;
  capture: (command: string, args: readonly string[]) => Promise<string>;
}>;

export type VmCommandInput = Readonly<{
  action: "open" | "login" | "stop" | "rm";
  project: string;
  sporeVersion: string;
  template?: string | undefined;
  modeFlag?: string | undefined;
  yes: boolean;
  stdout: Readonly<{ write: (text: string) => void }>;
  confirm?: ((question: string) => Promise<boolean>) | undefined;
}>;

const limaInstall =
  "fungi vm needs Lima. Install it with brew install lima (macOS) or follow https://lima-vm.io/docs/installation/ (Linux).";

/** `fungi-<folder>-<hash>`: stable per real project path, valid as a Lima name. */
export function vmInstanceName(project: string): string {
  const slug =
    basename(project)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 24)
      .replace(/-+$/u, "") || "project";
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 6);
  return `fungi-${slug}-${hash}`;
}

// `limactl list --json` prints one instance object per line.
const limaInstance = z.looseObject({
  name: z.string(),
  status: z.string(),
  sshConfigFile: z.string().optional(),
});
type LimaInstance = z.infer<typeof limaInstance>;

async function readInstance(
  runner: VmRunner,
  name: string,
): Promise<LimaInstance | undefined> {
  const output = await runner.capture("limactl", ["list", "--json"]);
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => limaInstance.parse(JSON.parse(line)))
    .find((instance) => instance.name === name);
}

async function native(
  input: VmCommandInput,
  runner: VmRunner,
  command: string,
  args: readonly string[],
): Promise<number> {
  input.stdout.write(`$ ${[command, ...args].join(" ")}\n`);
  const code = await runner.run(command, args);
  if (code === "missing")
    throw new Error(
      command === "limactl" ? limaInstall : `${command} is not installed`,
    );
  return code;
}

async function mustSucceed(
  input: VmCommandInput,
  runner: VmRunner,
  args: readonly string[],
): Promise<void> {
  const code = await native(input, runner, "limactl", args);
  if (code !== 0)
    throw new Error(
      `limactl ${args[0] ?? ""} failed with exit code ${String(code)}`,
    );
}

/** Create or start the project's VM; return its Lima state once running. */
async function ensureRunning(
  input: VmCommandInput,
  runner: VmRunner,
  name: string,
): Promise<LimaInstance> {
  const existing = await readInstance(runner, name);
  if (existing === undefined) {
    input.stdout.write(
      `Creating ${name}: a Linux VM with only ${input.project} mounted, writable.\n` +
        "The agent can change and run anything in this project folder and reach the internet.\n",
    );
    await mustSucceed(input, runner, [
      "start",
      `--name=${name}`,
      `--mount-only=${input.project}:w`,
      `--param=SPORE_VERSION=${input.sporeVersion}`,
      "--tty=false",
      input.template ?? fungiVmTemplate,
    ]);
  } else if (existing.status === "Stopped") {
    await mustSucceed(input, runner, ["start", "--tty=false", name]);
  } else if (existing.status !== "Running") {
    throw new Error(
      `Lima reports ${name} as ${existing.status}. Check it with limactl list ${name}.`,
    );
  }
  const running = await readInstance(runner, name);
  if (running?.status !== "Running")
    throw new Error(
      `${name} did not start. Check it with limactl list ${name}.`,
    );
  return running;
}

/** `fungi vm`: a thin door over Lima's own lifecycle; Lima keeps all VM state. */
export async function runVmCommand(
  input: VmCommandInput,
  runner: VmRunner,
): Promise<number> {
  const name = vmInstanceName(input.project);
  if (input.action === "open") {
    await ensureRunning(input, runner, name);
    return native(input, runner, "limactl", [
      "shell",
      `--workdir=${input.project}`,
      name,
      "fungi",
      ...(input.modeFlag === undefined ? [] : [input.modeFlag]),
    ]);
  }
  if (input.action === "login") {
    const running = await ensureRunning(input, runner, name);
    if (running.sshConfigFile === undefined)
      throw new Error(`Lima did not report an SSH config for ${name}`);
    // Only for this login: the ChatGPT callback reaches the VM's 127.0.0.1:1455.
    return native(input, runner, "ssh", [
      "-F",
      running.sshConfigFile,
      "-t",
      "-L",
      "127.0.0.1:1455:127.0.0.1:1455",
      `lima-${name}`,
      "fungi",
      "login",
    ]);
  }
  const existing = await readInstance(runner, name);
  if (existing === undefined) {
    input.stdout.write(`No VM for this folder (${name}).\n`);
    return 0;
  }
  if (input.action === "stop") {
    if (existing.status === "Stopped") {
      input.stdout.write(`${name} is already stopped.\n`);
      return 0;
    }
    return native(input, runner, "limactl", ["stop", name]);
  }
  if (existing.status !== "Stopped")
    throw new Error(
      `${name} is ${existing.status}. Stop it first: fungi vm stop`,
    );
  const question = `Delete ${name} and its disk? Logins and anything saved only inside the VM are lost. ${input.project} is kept.`;
  if (!input.yes) {
    if (input.confirm === undefined)
      throw new Error("fungi vm rm needs --yes without a terminal");
    if (!(await input.confirm(question))) {
      input.stdout.write("Kept the VM.\n");
      return 0;
    }
  }
  return native(input, runner, "limactl", ["delete", name]);
}

/** The real runner: native commands share this terminal. */
export const nativeVmRunner: VmRunner = {
  run: (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: "inherit" });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") resolve("missing");
        else reject(error);
      });
      child.once("exit", (code, signal) => {
        resolve(code ?? (signal === null ? 1 : 128));
      });
    }),
  capture: (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(error.code === "ENOENT" ? new Error(limaInstall) : error);
      });
      child.once("exit", (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`${command} ${args.join(" ")} failed`));
      });
    }),
};
