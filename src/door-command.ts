import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * `fungi oyster …` and `fungi app …`: thin doors onto the packages that own
 * those commands. Spore dispatches and refuses; Oyster and create-fungi-app
 * keep their own behaviour, screens and help, so one copy of each exists.
 */

/** A refusal with the exact next step; the top-level catch prints it in Lantern's failure format. */
export class DoorFailure extends Error {
  constructor(
    title: string,
    readonly next: string,
  ) {
    super(title);
    this.name = "DoorFailure";
  }
}

export const oysterCommandHelp = `Usage: fungi oyster try [dir] [options]
       fungi oyster install-apps [options]
       fungi oyster install <dir|release.json> [options]

Run Oyster, your own Apps on this machine. This runs the same
@fungi.computer/oyster that npx @fungi.computer/oyster try runs, at the
version released with this fungi.

  try [dir]                      Create ./my-oyster and run it locally
  install-apps                   Install the starter Apps on a deployed Oyster
  install <dir|release.json>     Install a built App Release on an Oyster

Add --help to a command for its options, such as fungi oyster try --help.
See also: fungi app --help
`;

export const appCommandHelp = `Usage: fungi app create [dir] [--no-install]
       fungi app dev [--port <port>]
       fungi app build
       fungi app install <dir|release.json> [options]

Create, run and install a Fungi App. create runs the same create-fungi-app
that npm create fungi-app runs, at the version released with this fungi.

  create [dir]                   Scaffold an App in a new folder
  dev                            Run this App locally and rebuild on save
  build                          Build dist/release.json for this App
  install <dir|release.json>     Install a built Release on an Oyster

Add --help to create or install for its options.
See also: fungi oyster --help
`;

const packageVersion = z.looseObject({ version: z.string().min(1) });

function workspaceVersion(directory: string): string {
  return packageVersion.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../packages/${directory}/package.json`, import.meta.url),
        "utf8",
      ),
    ),
  ).version;
}

/**
 * The package versions released with this fungi. The bundle embeds them, so a
 * packed fungi never resolves `latest`; a source launch reads the workspace.
 */
type DoorPins = { oyster: string; createFungiApp: string };

// Global `process`, not an import: `bun build --define process.env.X` matches
// only the global, and the packed bundle embeds both pins that way.
function doorPins(): DoorPins {
  return {
    oyster: process.env.FUNGI_OYSTER_VERSION ?? workspaceVersion("oyster"),
    createFungiApp:
      process.env.FUNGI_CREATE_APP_VERSION ??
      workspaceVersion("create-fungi-app"),
  };
}

export type DoorInvocation = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
};

/** Run a door's child with inherited stdio and resolve its exit code. */
export type DoorRunner = (invocation: DoorInvocation) => Promise<number>;

const spawnDoor: DoorRunner = (invocation) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: { ...process.env, ...invocation.env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });

const oysterCommands = new Set(["try", "install-apps", "install"]);
const appCommands = new Set(["create", "dev", "build", "install"]);

function npmExec(
  packageSpec: string,
  bin: string,
  args: readonly string[],
): Pick<DoorInvocation, "command" | "args"> {
  return {
    command: "npm",
    args: ["exec", "--yes", `--package=${packageSpec}`, "--", bin, ...args],
  };
}

function isHelp(args: readonly string[]): boolean {
  return (
    args.length === 0 ||
    args[0] === "help" ||
    args[0] === "-h" ||
    args[0] === "--help"
  );
}

export async function runDoorCommand(options: {
  group: "oyster" | "app";
  args: readonly string[];
  cwd: string;
  sporeVersion: string;
  stdout: { write(chunk: string): boolean };
  runner?: DoorRunner | undefined;
}): Promise<void> {
  const { group, args, cwd, stdout } = options;
  const known = group === "oyster" ? oysterCommands : appCommands;
  const [subcommand, ...rest] = args;
  if (isHelp(args)) {
    stdout.write(group === "oyster" ? oysterCommandHelp : appCommandHelp);
    return;
  }
  if (subcommand === undefined || !known.has(subcommand))
    throw new DoorFailure(
      `Unknown ${group} command: ${subcommand ?? ""}`,
      `Run fungi ${group} --help`,
    );
  const pins = doorPins();
  const env = { FUNGI_HOST: `spore@${options.sporeVersion}` };
  let target: Pick<DoorInvocation, "command" | "args">;
  if (group === "oyster" || subcommand === "install")
    target = npmExec(`@fungi.computer/oyster@${pins.oyster}`, "oyster", args);
  else if (subcommand === "create")
    target = npmExec(
      `create-fungi-app@${pins.createFungiApp}`,
      "create-fungi-app",
      rest,
    );
  else {
    const bin = join(cwd, "node_modules", ".bin", "fungi-app");
    if (!existsSync(bin))
      throw new DoorFailure(
        "This folder is not a Fungi App",
        "Run fungi app create <dir>, or npm install here",
      );
    target = { command: bin, args };
  }
  const code = await (options.runner ?? spawnDoor)({ ...target, cwd, env });
  if (code !== 0) process.exitCode = code;
}
