import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const vmCommandHelp = `Usage: fungi vm [--yolo|--workspace|--read-only] [--port <n>]... [--template <file|url>]
       fungi vm login
       fungi vm stop
       fungi vm rm [--yes]

Open Shiitake in a Lima Linux VM that mounts only this project folder. A new
project's VM is a clone of a base VM prepared once per Spore version from the
Lima template inside Spore; later runs start it again and open fungi inside
it, in this folder. The agent can change and run
anything in this project folder and reach the internet. Your home folder and
SSH keys are not mounted. A firewall rule inside the VM blocks your computer's
localhost; root in the VM could remove it. Needs Lima: brew install lima on macOS, or
https://lima-vm.io/docs/installation/ on Linux.

  login      Show the VM's logins, then run fungi login in it. Claude uses
             copy-code sign-in; port 1455 is forwarded while it runs so a
             ChatGPT browser sign-in can finish
  stop       Stop the VM; its disk, tools and logins are kept
  rm         Delete a stopped VM and its disk; the project folder stays

      --port <n>                 Forward this port from the VM to the same port
                                 on this computer (repeatable; a stopped VM
                                 keeps it)
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
  /** Ports forwarded from the VM to the same port on this computer. */
  ports?: readonly number[] | undefined;
  modeFlag?: string | undefined;
  yes: boolean;
  stdout: Readonly<{ write: (text: string) => void }>;
  confirm?: ((question: string) => Promise<boolean>) | undefined;
}>;

export const limaInstall =
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
  config: z
    .looseObject({
      portForwards: z
        .array(z.looseObject({ guestPort: z.number().optional() }))
        .optional(),
    })
    .optional(),
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

async function readInstances(
  runner: VmRunner,
): Promise<readonly LimaInstance[]> {
  const output = await runner.capture("limactl", ["list", "--json"]);
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => limaInstance.parse(JSON.parse(line)));
}

async function readInstance(
  runner: VmRunner,
  name: string,
): Promise<LimaInstance | undefined> {
  return (await readInstances(runner)).find(
    (instance) => instance.name === name,
  );
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

/** One Lima lifecycle command with its chatter in the VM's log. */
async function quiet(
  input: VmCommandInput,
  runner: VmRunner,
  name: string,
  args: readonly string[],
  done: string,
): Promise<number> {
  await mkdir(input.logDirectory, { recursive: true });
  const log = join(input.logDirectory, `vm-${name}.log`);
  input.stdout.write(`$ limactl ${args.join(" ")}\n`);
  const code = await runner.runLogged("limactl", args, log);
  if (code === "missing") throw new Error(limaInstall);
  if (code !== 0)
    throw new Error(
      `limactl ${args[0] ?? ""} failed (exit code ${String(code)}). Log: ${log}`,
    );
  input.stdout.write(`${done}\n`);
  return 0;
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

/** A yq edit putting these forwards ahead of the template's ignore-all rules. */
function portForwardEdit(ports: readonly number[]): string {
  const forwards = ports.map((port) => ({ guestPort: port, hostPort: port }));
  return `--set=.portForwards = ${JSON.stringify(forwards)} + .portForwards`;
}

/** Ports asked for that this instance does not forward yet. */
function missingPorts(
  instance: LimaInstance,
  ports: readonly number[],
): readonly number[] {
  const forwarded = new Set(
    (instance.config?.portForwards ?? []).map((rule) => rule.guestPort),
  );
  return [...new Set(ports)].filter((port) => !forwarded.has(port));
}

/** Copy this computer's Git name and email into the VM, when set here. */
async function copyGitIdentity(
  input: VmCommandInput,
  runner: VmRunner,
  name: string,
): Promise<void> {
  const log = join(input.logDirectory, `vm-${name}.log`);
  for (const key of ["user.name", "user.email"]) {
    // --default "" makes an unset key an empty answer rather than an exit 1.
    const value = (
      await runner
        .capture("git", ["config", "--global", "--default", "", "--get", key])
        .catch((cause: unknown) => {
          input.stdout.write(
            `Could not read Git ${key} on this computer (${cause instanceof Error ? cause.message : "git failed"}); the VM keeps its own.\n`,
          );
          return "";
        })
    ).trim();
    if (value === "") continue;
    await runner.runLogged(
      "limactl",
      ["shell", "--workdir=/", name, "git", "config", "--global", key, value],
      log,
    );
  }
}

const basePrefix = "fungi-base-";

/**
 * The stopped base VM new project VMs are cloned from: provisioned once per
 * template and Spore version, so a new VM skips the Node.js and Spore install.
 */
async function ensureBase(
  input: VmCommandInput,
  runner: VmRunner,
  template: string,
): Promise<string> {
  const base = `${basePrefix}${createHash("sha256")
    .update(await readFile(template))
    .update(input.sporeVersion)
    .digest("hex")
    .slice(0, 10)}`;
  const instances = await readInstances(runner);
  let existing = instances.find((instance) => instance.name === base);
  if (existing?.status === "Running")
    await quiet(input, runner, base, ["stop", base], `Stopped ${base}.`);
  else if (existing !== undefined && existing.status !== "Stopped") {
    await quiet(
      input,
      runner,
      base,
      ["delete", "--force", base],
      `Deleted ${base}.`,
    );
    existing = undefined;
  }
  if (existing !== undefined) return base;
  input.stdout.write(
    "Preparing the base VM, once per Spore version: downloads Ubuntu, then installs Node.js and Spore (about a minute).\n",
  );
  await limaStart(
    input,
    runner,
    base,
    [
      `--name=${base}`,
      "--mount-none",
      `--param=SPORE_VERSION=${input.sporeVersion}`,
      "--tty=false",
      template,
    ],
    true,
  );
  await quiet(input, runner, base, ["stop", base], `Stopped ${base}.`);
  // Older bases (another template or Spore version) are only ever clone sources.
  for (const stale of instances)
    if (
      stale.name.startsWith(basePrefix) &&
      stale.name !== base &&
      stale.status === "Stopped"
    )
      await quiet(
        input,
        runner,
        stale.name,
        ["delete", stale.name],
        `Deleted ${stale.name}.`,
      );
  return base;
}

/** Create the project's VM from Spore's template, through the base clone. */
async function createFromBase(
  input: VmCommandInput,
  runner: VmRunner,
  name: string,
  template: string,
  ports: readonly number[],
): Promise<void> {
  const base = await ensureBase(input, runner, template);
  await quiet(
    input,
    runner,
    name,
    [
      "clone",
      "--tty=false",
      `--mount-only=${input.project}:w`,
      ...(ports.length === 0 ? [] : [portForwardEdit(ports)]),
      base,
      name,
    ],
    `Cloned ${name} from ${base}.`,
  ).catch(async (cause: unknown) => {
    if ((await readInstance(runner, name)) !== undefined)
      await runner.runLogged(
        "limactl",
        ["delete", "--force", name],
        join(input.logDirectory, `vm-${name}.log`),
      );
    throw cause;
  });
  await limaStart(input, runner, name, ["--tty=false", name], true);
}

/** Create or start the project's VM; return its Lima state once running. */
async function ensureRunning(
  input: VmCommandInput,
  runner: VmRunner,
  name: string,
): Promise<LimaInstance> {
  const ports = input.ports ?? [];
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
        "Your computer's localhost is blocked by a firewall rule inside the VM, which root there could remove.\n",
    );
    if (input.template === undefined)
      await createFromBase(input, runner, name, template, ports);
    else
      await limaStart(
        input,
        runner,
        name,
        [
          `--name=${name}`,
          `--mount-only=${input.project}:w`,
          `--param=SPORE_VERSION=${input.sporeVersion}`,
          ...(ports.length === 0 ? [] : [portForwardEdit(ports)]),
          "--tty=false",
          template,
        ],
        true,
      );
    await copyGitIdentity(input, runner, name);
  } else if (existing.status === "Stopped") {
    const added = missingPorts(existing, ports);
    if (added.length > 0) {
      const log = join(input.logDirectory, `vm-${name}.log`);
      const args = ["edit", "--tty=false", name, portForwardEdit(added)];
      input.stdout.write(`$ limactl ${args.join(" ")}\n`);
      if ((await runner.runLogged("limactl", args, log)) !== 0)
        throw new Error(`Lima could not add ports to ${name}. Log: ${log}`);
    }
    input.stdout.write(`Starting ${name}.\n`);
    await limaStart(input, runner, name, ["--tty=false", name], false);
    await copyGitIdentity(input, runner, name);
  } else if (missingPorts(existing, ports).length > 0) {
    throw new Error(
      `${name} is running without port ${missingPorts(existing, ports).join(", ")}. Stop it first to add ports: fungi vm stop`,
    );
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
    return quiet(input, runner, name, ["stop", name], `Stopped ${name}.`);
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
  return quiet(input, runner, name, ["delete", name], `Deleted ${name}.`);
}
