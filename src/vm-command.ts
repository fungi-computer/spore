import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const vmCommandHelp = `Usage: fungi vm [--yolo|--workspace|--read-only] [--template <file|url>]
       fungi vm login
       fungi vm stop
       fungi vm rm [--yes]

Open Shiitake in a Lima Linux VM that mounts only this project folder. The
first run creates the VM from the Lima template inside Spore; later runs start
it again and open fungi inside it, in this folder. The agent can change and run
anything in this project folder and reach the internet. Your home folder and
SSH keys are not mounted. A firewall rule inside the VM blocks your computer's
localhost; root in the VM could remove it. Needs Lima: brew install lima on macOS, or
https://lima-vm.io/docs/installation/ on Linux.

  login      Show the VM's logins, then run fungi login in it. Claude uses
             copy-code sign-in; port 1455 is forwarded while it runs so a
             ChatGPT browser sign-in can finish
  stop       Stop the VM; its disk, tools and logins are kept
  rm         Delete a stopped VM and its disk; the project folder stays

      --template <file|url>      Lima template for a new VM (default: Spore's)
      --yes                      Delete without asking
`;

/** The Lima template shipped in this Spore; never fetched at run time. */
export const fungiVmTemplate = fileURLToPath(
  new URL("./lima/fungi-vm.yaml", import.meta.url),
);

/** One native command; resolves with its exit code, or "missing" for ENOENT. */
export type VmRunner = Readonly<{
  run: (
    command: string,
    args: readonly string[],
  ) => Promise<number | "missing">;
  /** Like run, but Lima's output goes to a log file instead of the terminal. */
  runLogged: (
    command: string,
    args: readonly string[],
    log: string,
  ) => Promise<number | "missing">;
  capture: (command: string, args: readonly string[]) => Promise<string>;
  /** False on Linux when this user cannot open /dev/kvm. */
  kvmUsable: () => Promise<boolean>;
}>;

export type VmCommandInput = Readonly<{
  action: "open" | "login" | "stop" | "rm";
  project: string;
  sporeVersion: string;
  /** Where Lima's start output is written. */
  logDirectory: string;
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
  dir: z.string().optional(),
  sshConfigFile: z.string().optional(),
});
// Lima's JSON log lines (`--log-format=json`, and the host agent's stderr log).
const limaLogLine = z.looseObject({ level: z.string(), msg: z.string() });

const kvmRefusal =
  "Your user can't use /dev/kvm yet: add yourself to the kvm group (sudo usermod -aG kvm $USER) and log in again.";

/** The last fatal or error message in one Lima JSON log, if any. */
async function lastLimaFailure(path: string): Promise<string | undefined> {
  // A start that failed before Lima made the instance has no host-agent log.
  const text = await readFile(path, "utf8").catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return "";
    throw cause;
  });
  let failure: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    const parsed = limaLogLine.safeParse(JSON.parse(line));
    if (
      parsed.success &&
      (parsed.data.level === "fatal" || parsed.data.level === "error")
    )
      failure = parsed.data.msg;
  }
  return failure;
}
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

/**
 * Run one `limactl start` quietly. Its output goes to a log; a failure names
 * Lima's own cause and removes an instance this run half-created.
 */
async function limaStart(
  input: VmCommandInput,
  runner: VmRunner,
  name: string,
  args: readonly string[],
  created: boolean,
): Promise<void> {
  await mkdir(input.logDirectory, { recursive: true });
  const log = join(input.logDirectory, `vm-${name}.log`);
  const command = ["start", "--log-format=json", ...args];
  input.stdout.write(`$ limactl ${command.join(" ")}\n  Log: ${log}\n`);
  const startedAt = Date.now();
  const code = await runner.runLogged("limactl", command, log);
  if (code === "missing") throw new Error(limaInstall);
  if (code === 0) {
    input.stdout.write(
      `${name} is ready (${String(Math.round((Date.now() - startedAt) / 1000))} s).\n`,
    );
    return;
  }
  const instance = await readInstance(runner, name);
  const cause =
    (instance?.dir === undefined
      ? undefined
      : await lastLimaFailure(join(instance.dir, "ha.stderr.log"))) ??
    (await lastLimaFailure(log)) ??
    `limactl start exited with code ${String(code)}`;
  let removed = "";
  if (created && instance !== undefined) {
    await runner.runLogged("limactl", ["delete", "--force", name], log);
    removed = ` Removed the half-created ${name}.`;
  }
  throw new Error(
    `Lima could not start ${name}: ${cause}.${removed} Log: ${log}`,
  );
}

/** Create or start the project's VM; return its Lima state once running. */
async function ensureRunning(
  input: VmCommandInput,
  runner: VmRunner,
  name: string,
): Promise<LimaInstance> {
  const existing = await readInstance(runner, name);
  if (existing?.status !== "Running" && !(await runner.kvmUsable()))
    throw new Error(kvmRefusal);
  if (existing === undefined) {
    const template = input.template ?? fungiVmTemplate;
    if (input.template === undefined)
      await access(template).catch((cause: unknown) => {
        throw new Error(
          `Spore's VM template is missing at ${template}. Reinstall Spore: npm i -g @fungi.computer/spore`,
          { cause },
        );
      });
    input.stdout.write(
      `Creating ${name}: a Linux VM with only ${input.project} mounted, writable.\n` +
        "The agent can change and run anything in this project folder and reach the internet.\n" +
        "Your computer's localhost is blocked by a firewall rule inside the VM, which root there could remove.\n" +
        "First run: downloads Ubuntu, then installs Node.js and Spore in the VM (about a minute).\n",
    );
    await limaStart(
      input,
      runner,
      name,
      [
        `--name=${name}`,
        `--mount-only=${input.project}:w`,
        `--param=SPORE_VERSION=${input.sporeVersion}`,
        "--tty=false",
        template,
      ],
      true,
    );
  } else if (existing.status === "Stopped") {
    input.stdout.write(`Starting ${name}.\n`);
    await limaStart(input, runner, name, ["--tty=false", name], false);
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
    // Say what the VM is already signed in to before offering another login.
    await native(input, runner, "limactl", [
      "shell",
      "--workdir=/",
      name,
      "fungi",
      "status",
    ]);
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
  runLogged: (command, args, log) =>
    new Promise((resolve, reject) => {
      const output = createWriteStream(log, { flags: "a" });
      output.once("open", () => {
        const child = spawn(command, [...args], {
          stdio: ["ignore", output, output],
        });
        child.once("error", (error: NodeJS.ErrnoException) => {
          output.end();
          if (error.code === "ENOENT") resolve("missing");
          else reject(error);
        });
        child.once("exit", (code, signal) => {
          output.end();
          resolve(code ?? (signal === null ? 1 : 128));
        });
      });
      output.once("error", reject);
    }),
  kvmUsable: () =>
    process.platform !== "linux"
      ? Promise.resolve(true)
      : access("/dev/kvm", constants.R_OK | constants.W_OK).then(
          () => true,
          () => false,
        ),
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
