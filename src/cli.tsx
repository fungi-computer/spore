#!/usr/bin/env bun
import { userFacingCause } from "./panes/conversation/user-facing-cause.js";
import { displayText } from "./shell/display-text.js";
import questionClient from "@fungi.computer/shiitake-extensions/question/client";
import goalClient from "@fungi.computer/shiitake-extensions/goal/client";
import loopClient from "@fungi.computer/shiitake-extensions/loop/client";
import planClient from "@fungi.computer/shiitake-extensions/plan/client";
import subagentsClient from "@fungi.computer/shiitake-extensions/subagents/client";
import corralClient from "@fungi.computer/corral";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lstatSync } from "node:fs";
import { agentsCommandHelp, runAgentsCommand } from "./agents-command.js";
import {
  runComputersCommand,
  type ComputersCommandOwners,
} from "./computers-command.js";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { privateLocalServiceVersion } from "@fungi.computer/truffle/service";
import { Cli, isCancel } from "@fungi.computer/lantern";
import { z } from "zod";
import { Schema } from "effect";
import {
  loginAllowed,
  subscriptionKillSwitchFrom,
} from "@fungi.computer/veil/model-credentials";
import type { OneShotRunOptions } from "./one-shot-run.js";
import type { TuiCliDependencies } from "./cli-runtime.js";
import type { LocalAcpStdioOptions } from "@fungi.computer/truffle/acp-stdio";
import { fungiModelLoginNotice } from "./button/login-notice.js";
import type { LocalAuthCliOptions } from "@fungi.computer/truffle/auth";
import {
  createPrivateModels,
  resolveDefaultCredentialPath,
  activateSubscriptionCredential,
  CredentialActivationError,
  prepareSubscriptionIdentity,
  registerPrivateBundledModelOAuthFlows,
  listPrivateTeamComputers,
  startPrivateTeamComputer,
  attachPrivateLocalComputer,
  detachPrivateLocalComputer,
  listPrivateLocalComputers,
  signInFungiAccount,
  launchPlatformBrowser,
  runTrackerGitCredential,
  signOutFungiAccount,
  runPrivateLocalComputer,
  readFungiAccountStatus,
  runFungiAccountCommand,
  parseFungiMcpEndpoint,
  saveOysterMcpKey,
  type PrivateFungiAccountLoginOptions,
  type PrivateFungiAccountLogoutResult,
  type PrivateFungiMcpSelection,
} from "@fungi.computer/truffle";
import {
  createPrivateLocalServiceManager,
  runPrivateLocalWorkerServer,
  type PrivateLocalServiceSelection,
} from "@fungi.computer/truffle/service";
import { linearAuthInteraction } from "@fungi.computer/truffle/auth";
import { hasOnboarding, runOnboarding } from "./onboarding.js";
import { helpFor } from "./cli-help.js";
import {
  chooseSignInDoor,
  chooseSubscription,
  type SignInDoor,
} from "./sign-in-choice.js";
import { runDoctor } from "./doctor.js";
import { reportFailure } from "./button/log-event.js";
import {
  forgetProjectMcpConnection,
  readProjectMcpConnection,
  saveProjectMcpConnection,
} from "./project-mcp-connection.js";
import {
  extensionCommandHelp,
  projectExtensionParts,
  runExtensionCommand,
} from "./extension-command.js";
import { programPanes } from "./panes/terminal/index.js";
import {
  localExtensions,
  type LocalExtensions,
} from "@fungi.computer/truffle/extensions";
import { manageLocalExecRules } from "@fungi.computer/truffle/rules";

/** A subfolder command manages its ancestor project, never creates sub/.fungi. */
function permissionsProject(start: string): string {
  for (let current = resolve(start); ; current = dirname(current)) {
    if (
      lstatSync(join(current, ".fungi"), {
        throwIfNoEntry: false,
      })?.isDirectory() ||
      lstatSync(join(current, ".git"), { throwIfNoEntry: false }) !== undefined
    )
      return current;
    if (current === dirname(current)) return resolve(start);
  }
}
import {
  runComputerCommand,
  type ComputerCommandOwners,
} from "./computer-command.js";

const sessionClients = [
  goalClient,
  loopClient,
  planClient,
  corralClient,
  questionClient,
  subagentsClient,
];

if (process.env.FUNGI_BUNDLED_CLI !== undefined)
  registerPrivateBundledModelOAuthFlows();

const fungiVersion = z
  .looseObject({ version: z.string().min(1) })
  .parse(createRequire(import.meta.url)("../package.json")).version;

type ModelAuthCheck = Pick<
  NonNullable<LocalAuthCliOptions["models"]>,
  "checkAuth"
>;

/** Check the chosen provider; another login never satisfies the Fungi default. */
async function modelLoginMissing(
  models: ModelAuthCheck,
  providerId = "fungi",
): Promise<boolean> {
  try {
    return (await models.checkAuth(providerId)) === undefined;
  } catch (cause) {
    reportFailure("model-login-check", cause);
    return false;
  }
}

export type FungiCliIo = Readonly<{
  cwd?: string | undefined;
  stdin?: OneShotRunOptions["stdin"];
  stdout?: OneShotRunOptions["stdout"];
  signals?: OneShotRunOptions["signals"];
  authModels?: LocalAuthCliOptions["models"];
  /** Override terminal detection for the standalone login surface. */
  interactive?: boolean;
  /** Another fungi screen already showed the banner on this terminal. */
  quiet?: boolean;
}>;

export type TuiAuthCall = LocalAuthCliOptions & {
  method?: string;
  providerId?: string;
  authType?: string;
};

function authOptionsFromIo(
  io: FungiCliIo,
  credentialPath: string,
): TuiAuthCall {
  const options: TuiAuthCall = { credentialPath };
  if (io.stdin !== undefined) options.input = io.stdin;
  if (io.stdout !== undefined)
    options.output = new Writable({
      write(chunk: string | Uint8Array, _encoding, callback) {
        io.stdout?.write(chunk);
        callback();
      },
    });
  if (io.signals !== undefined)
    options.signals = {
      once(signal, listener) {
        io.signals?.on(signal, listener);
      },
      removeListener(signal, listener) {
        io.signals?.off(signal, listener);
      },
    };
  if (io.authModels !== undefined) options.models = io.authModels;
  return options;
}

function isInteractiveStream(
  stream: NonNullable<FungiCliIo["stdin"] | FungiCliIo["stdout"]>,
): boolean {
  return "isTTY" in stream && stream.isTTY;
}

// Node's parseArgs owns argv decoding. These schemas describe only the existing
// command grammar over its decoded strings; dispatch retains its further checks.
const fungiCommandSchema = z.enum([
  "resume",
  "new",
  "sessions",
  "agents",
  "run",
  "serve",
  "stop",
  "reload",
  "update",
  "login",
  "status",
  "account",
  "doctor",
  "logout",
  "computers",
  "computer",
  "extension",
  "permissions",
  "mcp",
  "acp",
  "help",
]);
type FungiCommand = z.infer<typeof fungiCommandSchema>;

const noFungiPositionals = z.tuple([]);
const optionalFungiPositional = z.tuple([z.string().optional()]);
type FungiArgumentRules = Partial<
  Record<FungiCommand, Readonly<{ schema: z.ZodType; error: string }>>
>;

// These three errors precede --last validation in the existing CLI.
const earlyFungiArgumentRules = {
  help: {
    schema: optionalFungiPositional,
    error: "fungi help accepts at most one command",
  },
  run: {
    schema: optionalFungiPositional,
    error: "fungi run accepts at most one prompt",
  },
  update: {
    schema: noFungiPositionals,
    error: "fungi update does not accept positional arguments",
  },
} satisfies FungiArgumentRules;

const fungiArgumentRules = {
  serve: {
    schema: noFungiPositionals,
    error: "fungi serve does not accept positional arguments",
  },
  computers: {
    schema: z.union([
      noFungiPositionals,
      z.tuple([z.literal("start"), z.string()]),
    ]),
    error: "Usage: fungi computers | fungi computers start <name>",
  },
  computer: {
    schema: z.union([
      z.tuple([z.literal("attach"), z.string(), z.string()]),
      z.tuple([z.literal("status")]),
      z.tuple([z.literal("detach"), z.string()]),
    ]),
    error:
      "Usage: fungi computer attach <computer> <folder> | status | detach <computer>",
  },
  account: {
    schema: z.union([
      noFungiPositionals,
      z.tuple([z.enum(["teams", "balance"])]),
      z.tuple([z.literal("use-team"), z.string()]),
    ]),
    error:
      "Usage: fungi account [--json] | teams [--json] | use-team <team-id> | balance [--json]",
  },
  extension: {
    schema: z.union([
      z.tuple([z.enum(["add", "remove"]), z.string()]),
      z.tuple([z.literal("list")]),
      z.tuple([
        z.enum(["enable", "disable"]),
        z.literal("project"),
        z.string(),
      ]),
      z.tuple([
        z.enum(["enable", "disable"]),
        z.enum(["agent", "skills"]),
        z.string(),
        z.string().optional(),
      ]),
    ]),
    error: extensionCommandHelp,
  },
  permissions: {
    schema: z.union([
      z.tuple([z.literal("list")]),
      z.tuple([z.literal("remove"), z.string()]),
    ]),
    error: "Usage: fungi permissions list | remove '<json-prefix>'",
  },
  mcp: {
    schema: z.union([
      z.tuple([z.enum(["show", "forget"])]),
      z.tuple([z.literal("use"), z.string()]),
    ]),
    error: "Usage: fungi mcp show | use <url> | forget",
  },
  agents: {
    schema: z.union([
      z.tuple([z.literal("list")]),
      z.tuple([z.enum(["archive", "unarchive"]), z.string()]),
    ]),
    error: agentsCommandHelp,
  },
  login: {
    schema: noFungiPositionals,
    error: "fungi login does not accept positional arguments",
  },
  status: {
    schema: noFungiPositionals,
    error: "fungi status does not accept positional arguments",
  },
  logout: {
    schema: noFungiPositionals,
    error: "fungi logout does not accept positional arguments",
  },
} satisfies FungiArgumentRules;

const namedSessionArguments = z.union([
  z.tuple([z.literal("list")]),
  z.tuple([z.enum(["resume", "show", "watch"]), z.string()]),
  z.tuple([z.literal("status"), z.string().optional()]),
]);
const lastSessionArguments = z.tuple([
  z.enum(["resume", "show", "watch", "status"]),
]);
const decimalSessionSelector = z.string().regex(/^[0-9]+$/u);
const listedSessionNumber = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .refine((value) => Number.isSafeInteger(Number(value)));

function validateFungiCommandName(
  command: string | undefined,
): FungiCommand | undefined {
  if (command === undefined) return undefined;
  const parsed = fungiCommandSchema.safeParse(command);
  if (!parsed.success) throw new Error(`Unknown fungi command: ${command}`);
  return parsed.data;
}

function validateFungiArguments(
  command: FungiCommand | undefined,
  positionals: readonly string[],
  rules: FungiArgumentRules,
): void {
  const rule = command === undefined ? undefined : rules[command];
  if (rule !== undefined && !rule.schema.safeParse(positionals).success)
    throw new Error(rule.error);
}

function validateFungiSessionArguments(
  positionals: readonly string[],
  last: boolean | undefined,
): void {
  const schema = last ? lastSessionArguments : namedSessionArguments;
  const parsed = schema.safeParse(positionals);
  if (!parsed.success)
    throw new Error(
      "Usage: fungi sessions list | resume <number|session-id|prefix>|--last | show|watch <id>|--last | status [id|--last]",
    );
  const [action, target] = parsed.data;
  if (
    action === "resume" &&
    target !== undefined &&
    decimalSessionSelector.safeParse(target).success &&
    !listedSessionNumber.safeParse(target).success
  )
    throw new Error(
      "Session number must be a positive integer from fungi sessions list",
    );
}

function validateFungiCommand(
  command: string | undefined,
  positionals: readonly string[],
  last: boolean | undefined,
): void {
  const recognized = validateFungiCommandName(command);
  validateFungiArguments(recognized, positionals, earlyFungiArgumentRules);
  if (last && recognized !== "resume" && recognized !== "sessions")
    throw new Error(
      "--last is only valid with fungi resume or fungi sessions resume",
    );
  validateFungiArguments(recognized, positionals, fungiArgumentRules);
  if (recognized === "sessions")
    validateFungiSessionArguments(positionals, last);
}

function validateFungiAuthOptions(
  command: string | undefined,
  values: Readonly<{
    cd?: string | undefined;
    connect?: string | undefined;
    db?: string | undefined;
    agent?: string | undefined;
    last?: boolean | undefined;
    listen?: string | undefined;
    model?: string | undefined;
    reasoning?: string | undefined;
    workers?: string | undefined;
    method?: string | undefined;
    "auth-type"?: string | undefined;
  }>,
): void {
  const isAuth =
    command === "login" || command === "status" || command === "logout";
  if (!isAuth) {
    if (values["auth-type"] !== undefined)
      throw new Error("--auth-type is only valid with fungi login");
    if (values.method !== undefined)
      throw new Error("--method is only valid with fungi login");
    return;
  }
  const option = [
    ["--cd", values.cd],
    ["--connect", values.connect],
    ["--db", values.db],
    ["--agent", values.agent],
    ["--last", values.last],
    ["--listen", values.listen],
    ["--model", values.model],
    ["--reasoning", values.reasoning],
    ["--workers", values.workers],
  ].find(([, value]) => value !== undefined && value !== false);
  if (option !== undefined)
    throw new Error(`${command} cannot be combined with ${String(option[0])}`);
}

function validateFungiListenerMode(
  command: string | undefined,
  last: boolean | undefined,
  listen: string | undefined,
): void {
  if (
    listen !== undefined &&
    (command === "run" || command === "resume" || last)
  )
    throw new Error("--listen is only valid with a fresh fungi TUI");
}

function validateFungiConnectedMode(
  command: string | undefined,
  last: boolean | undefined,
  options: Readonly<{
    cd: string | undefined;
    connect: string | undefined;
    db: string | undefined;
    agent: string | undefined;
    listen: string | undefined;
    model: string | undefined;
    provider: string | undefined;
    reasoning: string | undefined;
  }>,
): void {
  if (options.connect === undefined) return;
  if (options.listen !== undefined)
    throw new Error("--connect and --listen cannot be combined");
  const localOptionNames = new Set([
    "cd",
    "db",
    "agent",
    "provider",
    "model",
    "reasoning",
  ] as const);
  const hasLocalOption = [...localOptionNames].some(
    (name) => options[name] !== undefined,
  );
  if (hasLocalOption || command === "resume" || last)
    throw new Error(
      "--connect cannot be combined with local project or database options",
    );
}

/** CLI input may be decoded already; the Git helper owns a byte-bounded protocol. */
async function* gitCredentialBytes(input: AsyncIterable<string | Uint8Array>) {
  const encoder = new TextEncoder();
  for await (const chunk of input)
    yield Schema.is(Schema.Uint8Array)(chunk) ? chunk : encoder.encode(chunk);
}

/** Dispatch the installed fungi command without introducing a CLI framework. */
export async function runFungiCli(
  argv: readonly string[],
  io: FungiCliIo = {},
  overrides: Partial<TuiCliDependencies> & {
    signInFungi?: (
      endpoint: string,
      options: Pick<
        PrivateFungiAccountLoginOptions,
        "confirmReplace" | "chooseTeam" | "openBrowser"
      >,
    ) => Promise<void>;
    signOutFungi?: (
      endpoint?: string,
    ) => Promise<PrivateFungiAccountLogoutResult>;
    computersOwners?: Partial<ComputersCommandOwners>;
    /** The installed-extension owner; tests point it at a disposable home. */
    extensions?: LocalExtensions;
    computerOwners?: Partial<ComputerCommandOwners>;
    readFungiStatus?: typeof readFungiAccountStatus;
    runAcp?: (options: LocalAcpStdioOptions) => Promise<void>;
    runAuth?: (
      action: "status" | "login" | "logout",
      options?: TuiAuthCall,
    ) => Promise<void>;
  } = {},
  home = homedir(),
): Promise<void> {
  const credentialPath = resolveDefaultCredentialPath(home);
  const createServiceManager =
    overrides.createServiceManager ??
    (() => createPrivateLocalServiceManager({ home }));
  const readFungiStatus =
    overrides.readFungiStatus ??
    (() => readFungiAccountStatus({ credentialPath }));
  const signOutFungi =
    overrides.signOutFungi ??
    ((endpoint?: string) => signOutFungiAccount(endpoint, { credentialPath }));
  const signInFungi: NonNullable<typeof overrides.signInFungi> =
    overrides.signInFungi ??
    ((endpoint, options) =>
      signInFungiAccount(endpoint, { ...options, credentialPath }));
  const arguments_ = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      // Hidden: installed-launcher identity for Local service replacement.
      "internal-build-id": { type: "boolean" },
      db: { type: "string" },
      yolo: { type: "boolean" },
      "full-access": { type: "boolean" },
      workspace: { type: "boolean" },
      "read-only": { type: "boolean" },
      agent: { type: "string" },
      extension: { type: "string", multiple: true },
      "fungi-mcp": { type: "string" },
      "host-label": { type: "string" },
      hub: { type: "string" },
      team: { type: "string" },
      yes: { type: "boolean" },
      skills: { type: "boolean" },
      "no-skills": { type: "boolean" },
      model: { type: "string", short: "m" },
      provider: { type: "string" },
      "from-file": { type: "string" },
      "auth-type": { type: "string" },
      reasoning: { type: "string" },
      cd: { type: "string", short: "C" },
      last: { type: "boolean" },
      connect: { type: "string" },
      listen: { type: "string" },
      workers: { type: "string" },
      method: { type: "string" },
      errors: { type: "boolean" },
      archived: { type: "boolean" },
      json: { type: "boolean" },
      // Hidden developer option: build fungi from a Botanical checkout.
      "from-source": { type: "string" },
    },
    strict: true,
  });
  const [command, ...positionals] = arguments_.positionals;
  const stdout = io.stdout ?? process.stdout;
  /** This folder's enabled extension clients and programs; never Agent tools. */
  const projectExtensions = async (
    invocationRoot: string,
    extensions: readonly string[] | undefined,
  ) => {
    const parts = await projectExtensionParts(
      overrides.extensions ?? localExtensions({ home }),
      invocationRoot,
      (error) => {
        process.stderr.write(`Extension: ${error.message}\n`);
      },
    );
    return {
      extensions: [...(extensions ?? []), ...parts.clients],
      paneKinds: programPanes(parts.programs),
    };
  };
  if (arguments_.values.version) {
    stdout.write(`fungi ${fungiVersion}\n`);
    return;
  }
  if (arguments_.values["internal-build-id"]) {
    stdout.write(`${JSON.stringify(privateLocalServiceVersion())}\n`);
    return;
  }
  if (arguments_.values.help) {
    stdout.write(helpFor(command));
    return;
  }
  const fullAccess =
    arguments_.values.yolo === true ||
    arguments_.values["full-access"] === true;
  if (
    [
      fullAccess,
      arguments_.values.workspace,
      arguments_.values["read-only"],
    ].filter(Boolean).length > 1
  )
    throw new Error("Choose only one of --yolo, --workspace and --read-only");
  const mode: PrivateLocalServiceSelection["mode"] = fullAccess
    ? "full-access"
    : arguments_.values.workspace
      ? "workspace"
      : arguments_.values["read-only"]
        ? "read-only"
        : undefined;
  if (
    mode !== undefined &&
    command !== undefined &&
    !["new", "resume", "run"].includes(command)
  )
    throw new Error(
      "Permission mode flags are only valid with fungi, new, resume or run",
    );
  if (command === "git-credential") {
    const [action] = positionals;
    if (
      positionals.length !== 1 ||
      action === undefined ||
      arguments_.values.hub === undefined ||
      arguments_.values.team === undefined ||
      Object.keys(arguments_.values).some(
        (name) => name !== "hub" && name !== "team",
      )
    )
      throw new Error(
        "Usage: fungi git-credential remote|get|store|erase --hub <origin> --team <id>",
      );
    await runTrackerGitCredential({
      action,
      hub: arguments_.values.hub,
      teamId: arguments_.values.team,
      stdin: gitCredentialBytes(io.stdin ?? process.stdin),
      stdout,
    });
    return;
  }
  if (arguments_.values.team !== undefined)
    throw new Error("--team is only valid with git-credential");
  if (command === "account" && positionals[0] === "prepare-credential") {
    if (
      positionals.length !== 1 ||
      arguments_.values.provider === undefined ||
      Object.keys(arguments_.values).some((name) => name !== "provider")
    )
      throw new Error(
        "Usage: fungi account prepare-credential --provider anthropic|openai",
      );
    await prepareSubscriptionIdentity(arguments_.values.provider, {
      credentialPath,
    });
    stdout.write('{"ok":true}\n');
    return;
  }
  if (command === "account" && positionals[0] === "use-credential") {
    if (
      positionals.length !== 1 ||
      arguments_.values.provider === undefined ||
      arguments_.values["from-file"] !== "-" ||
      Object.keys(arguments_.values).some(
        (name) => name !== "provider" && name !== "from-file",
      )
    )
      throw new Error(
        "Usage: fungi account use-credential --provider anthropic|openai --from-file -",
      );
    try {
      await activateSubscriptionCredential(
        arguments_.values.provider,
        gitCredentialBytes(io.stdin ?? process.stdin),
        { credentialPath },
      );
    } catch (error) {
      if (error instanceof CredentialActivationError)
        stdout.write(
          `${JSON.stringify({ ok: false, error: { category: error.category } })}\n`,
        );
      throw error;
    }
    stdout.write('{"ok":true}\n');
    return;
  }
  if (
    arguments_.values["from-file"] !== undefined &&
    !(command === "mcp" && positionals[0] === "use")
  )
    throw new Error(
      "--from-file is only valid with account use-credential or mcp use",
    );
  validateFungiCommand(command, positionals, arguments_.values.last);
  if (
    command !== "extension" &&
    (arguments_.values.skills !== undefined ||
      arguments_.values["no-skills"] !== undefined)
  )
    throw new Error(
      "--skills and --no-skills are only valid with fungi extension add",
    );
  if (command === "help") {
    stdout.write(helpFor(positionals[0]));
    return;
  }
  if (command === "acp") {
    if (positionals[0] === "login") {
      const commandToken = arguments_.tokens.find(
        (token) => token.kind === "positional",
      );
      if (commandToken === undefined)
        throw new Error("ACP login requires a command token");
      const projectArguments = new Set([commandToken.index]);
      for (const token of arguments_.tokens) {
        if (token.kind === "option" && token.name === "cd") {
          projectArguments.add(token.index);
          if (!token.inlineValue) projectArguments.add(token.index + 1);
        }
      }
      await runFungiCli(
        argv.filter((_, index) => !projectArguments.has(index)),
        io,
        overrides,
        home,
      );
      return;
    }
    if (positionals.length > 0)
      throw new Error(
        "Usage: fungi acp [-C dir] | fungi acp login [login options]",
      );
    for (const name of Object.keys(arguments_.values)) {
      if (name !== "cd")
        throw new Error(`--${name} is not valid with fungi acp`);
    }
    const runAcp =
      overrides.runAcp ??
      (await import("@fungi.computer/truffle/acp-stdio"))
        .runPrivateLocalAcpStdio;
    await runAcp({
      manager: createServiceManager(),
      invocationRoot: resolve(
        io.cwd ?? process.cwd(),
        arguments_.values.cd ?? ".",
      ),
    });
    return;
  }
  const interactiveTerminal = () =>
    !arguments_.values.yes &&
    (io.interactive ??
      (isInteractiveStream(io.stdin ?? process.stdin) &&
        isInteractiveStream(stdout)));
  const hub = arguments_.values.hub;
  const linearCli = new Cli({
    brand: "fungi",
    interactive: interactiveTerminal(),
    columns: process.stdout.columns,
    input: io.stdin === undefined ? process.stdin : Readable.from(io.stdin),
    output:
      stdout instanceof Writable
        ? stdout
        : new Writable({
            write(chunk: string | Uint8Array, _encoding, callback) {
              stdout.write(chunk);
              callback();
            },
          }),
  });
  if (command === "login" && io.quiet !== true && linearCli.interactive)
    linearCli.welcome("fungi login");
  if (
    command === "login" &&
    linearCli.interactive &&
    hub === undefined &&
    arguments_.values.provider === undefined &&
    arguments_.values["auth-type"] === undefined &&
    arguments_.values.method === undefined &&
    arguments_.values["fungi-mcp"] === undefined
  ) {
    const door = await chooseSignInDoor(linearCli, { allowSkip: false });
    if (door === undefined || door === "later")
      throw new Error("Login cancelled.");
    await runFungiCli(
      await signInArguments(door, linearCli),
      { ...io, quiet: true },
      overrides,
      home,
    );
    return;
  }
  if (
    hub !== undefined &&
    (command !== "login" ||
      (arguments_.values.provider !== undefined &&
        arguments_.values.provider !== "fungi") ||
      arguments_.values["fungi-mcp"] !== undefined ||
      arguments_.values.method !== undefined ||
      (arguments_.values["auth-type"] !== undefined &&
        arguments_.values["auth-type"] !== "oauth"))
  )
    throw new Error("--hub is only valid with fungi login --provider fungi");
  let accountOrigin: string | undefined;
  if (
    command === "login" &&
    arguments_.values["fungi-mcp"] === undefined &&
    (arguments_.values.provider === "fungi" ||
      (arguments_.values.provider === undefined &&
        arguments_.values["auth-type"] === undefined &&
        arguments_.values.method === undefined))
  ) {
    if (
      arguments_.values.method !== undefined ||
      (arguments_.values["auth-type"] !== undefined &&
        arguments_.values["auth-type"] !== "oauth")
    )
      throw new Error("Fungi sign-in uses browser OAuth");
    if (
      !loginAllowed(
        {
          providerId: "fungi",
          method: "subscription",
          host: "local",
          scope: "user",
        },
        subscriptionKillSwitchFrom(process.env.FUNGI_SUBSCRIPTION_KILL),
      )
    )
      throw new Error("Fungi models are paused. Try again later.");
    const target = parseFungiMcpEndpoint(
      hub ?? (await readFungiStatus())?.issuer ?? "https://fungi.computer",
    );
    if (target.pathname !== "/")
      throw new Error("--hub must be a Fungi origin without a path");
    accountOrigin = target.href;
  }
  const endpoint = arguments_.values["fungi-mcp"];
  if (
    endpoint !== undefined &&
    (arguments_.values.connect !== undefined ||
      (command !== undefined &&
        command !== "run" &&
        command !== "resume" &&
        command !== "login" &&
        command !== "logout" &&
        command !== "computers" &&
        command !== "computer"))
  )
    throw new Error(
      "--fungi-mcp is only valid for a local Session, fungi login, fungi logout or fungi computer or fungi computers",
    );
  let fungiMcp: PrivateFungiMcpSelection | undefined =
    endpoint === undefined ? undefined : { endpoint };
  if (command === "doctor") {
    if (positionals.length > 0)
      throw new Error("fungi doctor does not accept positional arguments");
    const selected = await readProjectMcpConnection(
      resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? "."),
    );
    const passed = await runDoctor({
      localServiceStatus: () => createServiceManager().status(),
      models: io.authModels ?? createPrivateModels(credentialPath),
      fungiAccount: readFungiStatus,
      endpoint: selected?.endpoint,
      version: fungiVersion,
      interactive: interactiveTerminal(),
      write: (message) => stdout.write(message),
    });
    if (!passed)
      throw new Error("Doctor found issues; see the FAIL lines above.");
    return;
  }
  if (
    arguments_.values.extension !== undefined &&
    command !== undefined &&
    command !== "resume" &&
    command !== "new"
  )
    throw new Error("--extension is only valid with the terminal client");
  if (arguments_.values["from-source"] !== undefined && command !== "update")
    throw new Error("--from-source is only valid with fungi update");
  if (command === "update") {
    if (
      Object.keys(arguments_.values).some(
        (key) => key !== "cd" && key !== "from-source",
      )
    )
      throw new Error("fungi update accepts no options");
    const notify = (message: string) => {
      linearCli.info(message);
    };
    const source = arguments_.values["from-source"];
    if (source === undefined) {
      if (arguments_.values.cd !== undefined)
        throw new Error("-C is only valid with fungi update --from-source");
      const { runFungiReleaseUpdate } = await import("./update.js");
      await runFungiReleaseUpdate({ notify });
      return;
    }
    const { runFungiSourceUpdate } = await import("./update.js");
    await runFungiSourceUpdate({
      source: resolve(io.cwd ?? process.cwd(), source),
      project: resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? "."),
      notify,
    });
    return;
  }
  if (command === "reload") {
    if (
      positionals.length > 0 ||
      Object.keys(arguments_.values).some((key) => key !== "cd")
    )
      throw new Error("fungi reload accepts only -C <directory>");
    const manager = createServiceManager();
    linearCli.info(
      await manager.reload(
        resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? "."),
      ),
    );
    return;
  }
  if (command === "stop") {
    if (positionals.length > 0 || Object.keys(arguments_.values).length > 0)
      throw new Error("fungi stop does not accept arguments or options");
    const manager = createServiceManager();
    const stopped = await manager.stop();
    linearCli.info(
      stopped.kind === "not-running"
        ? stopped.recordCleaned
          ? "Local service wasn't running; cleaned up its record. Saved Sessions preserved."
          : "Local service wasn't running. Saved Sessions preserved."
        : stopped.kind === "replaced"
          ? "Local service was replaced; left the new service running."
          : stopped.kind === "killed"
            ? "Local service did not stop within 5 seconds, so it was killed. Saved Sessions preserved; interrupted turns resume when the service next starts."
            : "Local service stopped. Saved Sessions preserved.",
    );
    return;
  }
  if (command === "account") {
    if (Object.keys(arguments_.values).some((key) => key !== "json"))
      throw new Error("fungi account accepts only --json");
    const [action, teamId] = positionals;
    await runFungiAccountCommand(
      action === "use-team" && teamId !== undefined
        ? { action, teamId }
        : {
            action:
              action === "teams" || action === "balance" ? action : "status",
          },
      { json: arguments_.values.json === true, stdout, credentialPath },
    );
    return;
  }
  if (command === "mcp") {
    const invalid = Object.keys(arguments_.values).filter(
      (key) => key !== "cd" && key !== "from-file",
    );
    if (invalid.length > 0)
      throw new Error("fungi mcp accepts only -C or --cd and --from-file -");
    const root = resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? ".");
    if (positionals[0] === "use" && positionals[1] !== undefined) {
      const fromFile = arguments_.values["from-file"];
      if (fromFile !== undefined && fromFile !== "-")
        throw new Error(
          "Oyster keys must be supplied on stdin with --from-file -",
        );
      if (fromFile === "-")
        await saveOysterMcpKey(
          parseFungiMcpEndpoint(positionals[1]),
          gitCredentialBytes(io.stdin ?? process.stdin),
          { credentialPath },
        );
      const selected = await saveProjectMcpConnection(
        root,
        positionals[1],
        fromFile === "-" ? "oyster-key" : undefined,
      );
      stdout.write(
        `Team MCP for ${root}: ${selected}\nRun fungi stop before switching a running Local service.\n`,
      );
    } else if (positionals[0] === "forget") {
      await forgetProjectMcpConnection(root);
      stdout.write(
        `Forgot Team MCP for ${root}. Run fungi stop to clear a running Local service connection.\n`,
      );
    } else {
      const selected = await readProjectMcpConnection(root);
      stdout.write(
        selected === undefined
          ? `No Team MCP selected for ${root}.\n`
          : `Team MCP for ${root}: ${selected.endpoint}\n`,
      );
    }
    return;
  }
  if (arguments_.values.archived === true && command !== "agents")
    throw new Error("--archived is only valid with fungi agents list");
  if (command === "agents") {
    const [action, agentId] = positionals;
    const invalid = Object.keys(arguments_.values).filter(
      (key) => key !== "cd" && !(key === "archived" && action === "list"),
    );
    if (
      invalid.length > 0 ||
      (action !== "list" && action !== "archive" && action !== "unarchive")
    )
      throw new Error(agentsCommandHelp);
    await runAgentsCommand({
      action,
      agentId,
      archived: arguments_.values.archived === true,
      invocationRoot: resolve(
        io.cwd ?? process.cwd(),
        arguments_.values.cd ?? ".",
      ),
      manager: createServiceManager(),
      stdout,
    });
    return;
  }
  if (command === "sessions") {
    const action = positionals[0];
    const invalid = Object.keys(arguments_.values).filter(
      (key) =>
        key !== "cd" &&
        key !== "last" &&
        !(
          ((action === "show" || action === "watch") &&
            (key === "errors" || key === "json")) ||
          (action === "status" && key === "json")
        ),
    );
    if (invalid.length > 0)
      throw new Error(
        "fungi sessions accepts only -C, --last, --errors, or --json as documented",
      );
    const invocationRoot = resolve(
      io.cwd ?? process.cwd(),
      arguments_.values.cd ?? ".",
    );
    const manager = createServiceManager();
    const discovery = await manager.discover(invocationRoot);
    if (
      discovery.problems.length > 0 &&
      !(action === "status" && arguments_.values.json === true)
    )
      stdout.write(
        `Skipped ${String(discovery.problems.length)} unreadable saved conversation(s).\n`,
      );
    if (positionals[0] === "list") {
      if (discovery.sessions.length === 0) {
        stdout.write(`No saved conversations in ${invocationRoot}.\n`);
      } else {
        for (const [index, session] of discovery.sessions.entries())
          stdout.write(
            `${String(index + 1)}. ${displayText(session.title)}  ${session.sessionId}  ${new Date(session.updatedAt).toLocaleString()}\n`,
          );
      }
      return;
    }
    if (action === "status") {
      const selector = positionals[1];
      const exact = discovery.sessions.find(
        (session) => session.sessionId === selector,
      );
      const matches =
        selector === undefined || exact !== undefined
          ? []
          : discovery.sessions.filter((session) =>
              session.sessionId.startsWith(selector),
            );
      if (matches.length > 1)
        throw new Error(
          `Session ID prefix ${selector ?? ""} matches ${String(matches.length)} Sessions; use more characters`,
        );
      const selected =
        selector === undefined ? discovery.sessions[0] : (exact ?? matches[0]);
      if (selected === undefined)
        throw new Error(
          `No Session matching ${selector ?? "--last"}; run fungi sessions list -C ${invocationRoot}`,
        );
      const inspected = await manager.inspect(
        {
          invocationRoot,
          sessionId: selected.sessionId,
          databasePath: selected.databasePath,
        },
        { limit: 1 },
      );
      try {
        const { renderSessionStatus } = await import("./session-inspection.js");
        stdout.write(
          renderSessionStatus(
            inspected.snapshot,
            selected.updatedAt,
            arguments_.values.json === true,
          ),
        );
      } finally {
        await inspected.close();
      }
      return;
    }
    if (action === "show" || action === "watch") {
      const sessionId = arguments_.values.last
        ? discovery.sessions[0]?.sessionId
        : positionals[1];
      if (sessionId === undefined)
        throw new Error(`No saved conversations in ${invocationRoot}`);
      const selected = discovery.sessions.find(
        (session) => session.sessionId === sessionId,
      );
      if (selected === undefined)
        throw new Error(
          `Unknown Session ${sessionId}; run fungi sessions list -C ${invocationRoot}`,
        );
      const { runSessionInspection } = await import("./session-inspection.js");
      await runSessionInspection({
        inspect: (selection, options) => manager.inspect(selection, options),
        selection: {
          invocationRoot,
          sessionId: selected.sessionId,
          databasePath: selected.databasePath,
        },
        watch: action === "watch",
        errorsOnly: arguments_.values.errors === true,
        json: arguments_.values.json === true,
        signals: io.signals,
        write: (value) => {
          stdout.write(value);
        },
      });
      return;
    }
    const selector = positionals[1];
    const index = arguments_.values.last
      ? 0
      : selector !== undefined && /^[0-9]+$/u.test(selector)
        ? Number(selector) - 1
        : undefined;
    const exact = discovery.sessions.find(
      (session) => session.sessionId === selector,
    );
    const matches =
      exact === undefined && selector !== undefined && index === undefined
        ? discovery.sessions.filter((session) =>
            session.sessionId.startsWith(selector),
          )
        : [];
    if (matches.length > 1)
      throw new Error(
        `Session ID prefix ${selector ?? ""} matches ${String(matches.length)} Sessions; use more characters or a listed number`,
      );
    const selected =
      index === undefined ? (exact ?? matches[0]) : discovery.sessions[index];
    if (selected === undefined)
      throw new Error(
        discovery.sessions.length === 0
          ? `No saved conversations in ${invocationRoot}`
          : `No Session matching ${selector ?? "--last"}; run fungi sessions list -C ${invocationRoot}`,
      );
    const { runTuiCli } = await import("./cli-runtime.js");
    const savedConnection = await readProjectMcpConnection(invocationRoot);
    await runTuiCli(
      {
        invocationRoot,
        sessionChoice: selected,
        clients: sessionClients,
        questionExtensionId: questionClient.id,
        ...(await projectExtensions(invocationRoot, undefined)),
        fungiMcp: savedConnection,
      },
      overrides,
    );
    return;
  }
  if (command !== "computer" && arguments_.values["host-label"] !== undefined)
    throw new Error("--host-label is only valid with fungi computer attach");
  if (command === "computers") {
    const selected =
      endpoint ??
      (
        await readProjectMcpConnection(
          resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? "."),
        )
      )?.endpoint;
    if (selected === undefined)
      throw new Error(
        "fungi computers requires --fungi-mcp <url> or a saved project endpoint (fungi mcp use <url>)",
      );
    await runComputersCommand(
      {
        endpoint: selected,
        name: positionals[1],
        cli: linearCli,
        signals: io.signals,
      },
      {
        list: (endpoint, options) =>
          listPrivateTeamComputers(endpoint, { ...options, credentialPath }),
        start: (endpoint, name, options) =>
          startPrivateTeamComputer(endpoint, name, {
            ...options,
            credentialPath,
          }),
        ...overrides.computersOwners,
      },
    );
    return;
  }
  if (command === "extension") {
    const [action, ...rest] = positionals;
    for (const name of Object.keys(arguments_.values))
      if (
        name !== "cd" &&
        !(action === "add" && (name === "skills" || name === "no-skills"))
      )
        throw new Error(
          `--${name} is not valid with fungi extension ${action ?? ""}`.trim(),
        );
    if (
      arguments_.values.skills === true &&
      arguments_.values["no-skills"] === true
    )
      throw new Error("Choose one of --skills and --no-skills");
    if (
      action !== "add" &&
      action !== "list" &&
      action !== "remove" &&
      action !== "enable" &&
      action !== "disable"
    )
      throw new Error(extensionCommandHelp);
    await runExtensionCommand(
      {
        action,
        arguments: rest,
        cwd: resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? "."),
        stdout,
        skills:
          arguments_.values.skills === true
            ? true
            : arguments_.values["no-skills"] === true
              ? false
              : undefined,
        confirm: interactiveTerminal()
          ? (question) => confirm(io, question, true)
          : undefined,
      },
      overrides.extensions ?? localExtensions({ home }),
    );
    return;
  }
  if (command === "permissions") {
    const [action, value] = positionals;
    for (const name of Object.keys(arguments_.values))
      if (name !== "cd")
        throw new Error(`--${name} is not valid with fungi permissions`);
    const prefix =
      action === "remove"
        ? z
            .array(z.string().min(1))
            .min(1)
            .parse(JSON.parse(value ?? ""))
        : undefined;
    const rules = manageLocalExecRules(
      permissionsProject(
        resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? "."),
      ),
      action === "remove" ? "remove" : "list",
      prefix,
    );
    for (const rule of rules) stdout.write(`${JSON.stringify(rule)}\n`);
    return;
  }
  if (command === "computer") {
    const [action, computer, folder] = positionals;
    if (action !== "attach" && action !== "status" && action !== "detach")
      throw new Error("Unknown fungi computer action");
    await runComputerCommand(
      {
        action,
        computer,
        folder:
          folder === undefined
            ? undefined
            : resolve(io.cwd ?? process.cwd(), folder),
        endpoint,
        hostLabel: arguments_.values["host-label"],
        yes: arguments_.values.yes === true,
        stdout,
        signals: io.signals,
        confirm: interactiveTerminal()
          ? (question) => confirm(io, question)
          : undefined,
      },
      {
        attach: (endpoint, input, options) =>
          attachPrivateLocalComputer(endpoint, input, {
            ...options,
            credentialPath,
          }),
        detach: (endpoint, computer, options) =>
          detachPrivateLocalComputer(endpoint, computer, {
            ...options,
            credentialPath,
          }),
        list: (options) =>
          listPrivateLocalComputers({ ...options, credentialPath }),
        run: (endpoint, computer, options) =>
          runPrivateLocalComputer(endpoint, computer, {
            ...options,
            credentialPath,
          }),
        ...overrides.computerOwners,
      },
    );
    return;
  }
  validateFungiAuthOptions(command, arguments_.values);
  if (command === "login" || command === "status" || command === "logout") {
    const signInEndpoint = endpoint ?? accountOrigin;
    if (signInEndpoint !== undefined) {
      if (
        endpoint !== undefined &&
        (arguments_.values.provider !== undefined ||
          arguments_.values["auth-type"] !== undefined ||
          arguments_.values.method !== undefined)
      )
        throw new Error(
          `--fungi-mcp ${command} cannot be combined with provider login options`,
        );
      if (command === "logout") {
        const result = await signOutFungi(signInEndpoint);
        stdout.write(`${result.message}\n`);
        return;
      }
      const loginOptions: Pick<
        PrivateFungiAccountLoginOptions,
        "confirmReplace" | "chooseTeam" | "openBrowser"
      > = {
        openBrowser: (url) => {
          linearCli.info("Sign in to Fungi");
          linearCli.info(linearCli.link("Open sign-in page", url.href));
          linearCli.url(url.href);
          linearCli.info("Waiting for the browser… Finish signing in there.");
          launchPlatformBrowser(url);
        },
      };
      if (interactiveTerminal())
        loginOptions.confirmReplace = (savedIssuer, nextIssuer) =>
          confirm(
            io,
            `Fungi is logged in to ${savedIssuer}. Log out there and log in to ${nextIssuer}?`,
          );
      if (interactiveTerminal())
        loginOptions.chooseTeam = (teams) =>
          linearAuthInteraction(true, linearCli).prompt({
            type: "select",
            message: "Which Team pays for Fungi models?",
            options: teams.map((team) => ({
              id: team.teamId,
              label: team.name,
              description: team.handle,
            })),
          });
      await signInFungi(signInEndpoint, loginOptions);
      stdout.write(
        "Fungi login complete. Models and Team MCP use this account.\n",
      );
      return;
    }
    if (command === "logout" && arguments_.values.provider === "fungi") {
      const result = await signOutFungi();
      stdout.write(`${result.message}\n`);
      return;
    }
    const runAuth =
      overrides.runAuth ??
      (async (action: "status" | "login" | "logout", options) => {
        const { runLocalAuthCli } =
          await import("@fungi.computer/truffle/auth");
        const { method, providerId, authType, ...authOptions } = options ?? {};
        const args: string[] = [action];
        if (providerId !== undefined) args.push("--provider", providerId);
        if (authType !== undefined) args.push("--auth-type", authType);
        if (method !== undefined) args.push("--method", method);
        await runLocalAuthCli(args, authOptions);
      });
    const authCall = authOptionsFromIo(io, credentialPath);
    if (command === "login")
      authCall.interaction = linearAuthInteraction(
        interactiveTerminal(),
        linearCli,
      );
    if (arguments_.values.provider !== undefined)
      authCall.providerId = arguments_.values.provider;
    if (arguments_.values["auth-type"] !== undefined)
      authCall.authType = arguments_.values["auth-type"];
    if (arguments_.values.method !== undefined)
      authCall.method = arguments_.values.method;
    if (
      command === "login" &&
      authCall.providerId === undefined &&
      linearCli.interactive
    ) {
      const { chooseLoginProvider } =
        await import("./login-provider-picker.js");
      const models = authCall.models ?? createPrivateModels(credentialPath);
      authCall.models = models;
      authCall.providerId = await chooseLoginProvider(
        linearCli,
        models,
        io.signals,
        authCall.authType === "oauth" || authCall.authType === "api_key"
          ? authCall.authType
          : undefined,
      );
    }
    if (
      command === "status" &&
      (authCall.providerId === undefined || authCall.providerId === "fungi")
    ) {
      const login = await readFungiStatus();
      stdout.write(
        login === undefined
          ? "Fungi account: not signed in. Run fungi login.\n"
          : `Fungi account: ${parseFungiMcpEndpoint(login.issuer).host} · ${login.team === undefined ? "no Team chosen; run fungi login --provider fungi" : `${login.team.name} (${login.team.handle})`}\n`,
      );
    }
    await runAuth(command, authCall);
    return;
  }
  const { parseReasoning } = await import("./reasoning-option.js");
  const reasoning = parseReasoning(arguments_.values.reasoning);
  if (command === "serve") {
    if (
      arguments_.values.workers === undefined ||
      arguments_.values.listen === undefined
    )
      throw new Error("fungi serve requires --workers and --listen");
    if (
      arguments_.values.connect !== undefined ||
      arguments_.values.last ||
      arguments_.values.db !== undefined ||
      arguments_.values.agent !== undefined ||
      arguments_.values.provider !== undefined ||
      arguments_.values.model !== undefined ||
      arguments_.values.reasoning !== undefined ||
      arguments_.values.cd !== undefined
    )
      throw new Error(
        "fungi serve cannot be combined with client or local owner options",
      );
    await runPrivateLocalWorkerServer(
      arguments_.values.workers,
      arguments_.values.listen,
      {
        cwd: io.cwd ?? process.cwd(),
        home,
        stdout: io.stdout,
        signals: io.signals,
      },
    );
    return;
  }
  if (arguments_.values.workers !== undefined)
    throw new Error("--workers is only valid with fungi serve");
  validateFungiConnectionOptions(command, arguments_.values.last, {
    cd: arguments_.values.cd,
    connect: arguments_.values.connect,
    db: arguments_.values.db,
    agent: arguments_.values.agent,
    listen: arguments_.values.listen,
    provider: arguments_.values.provider,
    model: arguments_.values.model,
    reasoning,
  });
  const invocationRoot = resolve(
    io.cwd ?? process.cwd(),
    arguments_.values.cd ?? ".",
  );
  fungiMcp ??= await readProjectMcpConnection(invocationRoot);
  const common = {
    fungiMcp,
    invocationRoot,
    databasePath: arguments_.values.db,
    mode,
    providerId: arguments_.values.provider,
    modelId: arguments_.values.model,
    reasoning,
  };
  const models = () => io.authModels ?? createPrivateModels(credentialPath);
  if (
    command === undefined &&
    arguments_.values.connect === undefined &&
    arguments_.values.listen === undefined &&
    (await modelLoginMissing(models(), arguments_.values.provider)) &&
    !(await hasOnboarding())
  ) {
    const start = await runOnboarding({
      interactive: interactiveTerminal(),
      yes: arguments_.values.yes ?? false,
      input: io.stdin === undefined ? process.stdin : Readable.from(io.stdin),
      write: (message) => stdout.write(message),
      signIn: async (door, cli) =>
        runFungiCli(
          await signInArguments(door, cli),
          { ...io, quiet: true },
          overrides,
          home,
        ),
    });
    if (!start) return;
  }
  if ((command === undefined || command === "new") && !interactiveTerminal()) {
    stdout.write(
      "A terminal is needed for the agent UI. Use fungi run <prompt> for automation.\n",
    );
    return;
  }
  if (command === "run") {
    const { runOneShotCli } = await import("./one-shot-cli.js");
    try {
      await runOneShotCli(
        {
          ...common,
          agentId: arguments_.values.agent,
          prompt: positionals[0],
          stdin: io.stdin,
          stdout: io.stdout,
          signals: io.signals,
          connect: arguments_.values.connect,
        },
        { ...overrides, createServiceManager },
      );
    } catch (cause) {
      if (await modelLoginMissing(models(), arguments_.values.provider))
        process.stderr.write(`${fungiModelLoginNotice}\n`);
      throw cause;
    }
  } else {
    if (command === "resume" && arguments_.values.connect === undefined) {
      const manager = createServiceManager();
      const { sessions } = await manager.discover(invocationRoot);
      if (sessions.length === 0) {
        stdout.write(
          `No saved conversations in ${invocationRoot} yet. Run fungi to start one.\n`,
        );
        return;
      }
    }
    const { runTuiCli } = await import("./cli-runtime.js");
    await runTuiCli(
      {
        ...common,
        ...(await projectExtensions(
          invocationRoot,
          arguments_.values.extension,
        )),
        clients: sessionClients,
        questionExtensionId: questionClient.id,
        resume: command === "resume",
        entry:
          command === "new"
            ? "new"
            : command === undefined &&
                arguments_.values.connect === undefined &&
                arguments_.values.listen === undefined
              ? "landing"
              : undefined,
        last: arguments_.values.last,
        connect: arguments_.values.connect,
        listen: arguments_.values.listen,
      },
      { ...overrides, createServiceManager },
      home,
    );
  }
  if (endpoint !== undefined)
    await saveProjectMcpConnection(invocationRoot, endpoint);
}

/** The `fungi login` arguments for one sign-in door. */
async function signInArguments(
  door: SignInDoor,
  cli: Pick<Cli, "select">,
): Promise<string[]> {
  if (door === "fungi") return ["login", "--provider", "fungi"];
  if (door === "api_key") return ["login", "--auth-type", "api_key"];
  const provider = await chooseSubscription(cli);
  if (provider === undefined) throw new Error("Login cancelled.");
  return ["login", "--provider", provider, "--auth-type", "oauth"];
}

/** Ask one yes/no question on the command's own terminal streams. */
async function confirm(
  io: FungiCliIo,
  question: string,
  initialValue = false,
): Promise<boolean> {
  const cli = new Cli({
    brand: "fungi",
    interactive: true,
    input: io.stdin === undefined ? process.stdin : Readable.from(io.stdin),
    output: new Writable({
      write(chunk: string | Uint8Array, _encoding, callback) {
        (io.stdout ?? process.stdout).write(chunk);
        callback();
      },
    }),
  });
  const answer = await cli.confirm({ message: question, initialValue });
  return !isCancel(answer) && answer;
}

function validateFungiConnectionOptions(
  command: string | undefined,
  last: boolean | undefined,
  options: Readonly<{
    cd: string | undefined;
    connect: string | undefined;
    db: string | undefined;
    agent: string | undefined;
    listen: string | undefined;
    provider: string | undefined;
    model: string | undefined;
    reasoning: string | undefined;
  }>,
): void {
  if (options.agent !== undefined) {
    if (command !== "run")
      throw new Error("--agent is only valid with fungi run");
    if (options.db !== undefined)
      throw new Error("--agent and --db cannot be combined");
  }
  validateFungiListenerMode(command, last, options.listen);
  validateFungiConnectedMode(command, last, options);
}

if (import.meta.main) {
  // Source launches and internal-service starts have the same release source
  // as the npm launcher; Local must never read the TUI source manifest.
  process.env.FUNGI_SPORE_VERSION = fungiVersion;
  try {
    if (process.argv[2] === "--internal-service-restart") {
      const { createPrivateLocalServiceManager } =
        await import("@fungi.computer/truffle/service");
      const { restartUpdatedFungiService } = await import("./update.js");
      await restartUpdatedFungiService(createPrivateLocalServiceManager());
    } else if (process.argv[2] === "--internal-service") {
      const { runPrivateLocalService } =
        await import("@fungi.computer/truffle/service-process");
      const directory = process.argv[3];
      if (directory === undefined)
        throw new Error("Local service requires its private directory");
      await runPrivateLocalService(directory);
    } else {
      await runFungiCli(process.argv.slice(2), { cwd: process.cwd() });
    }
  } catch (cause) {
    process.stderr.write(
      `fungi: ${cause instanceof Error ? userFacingCause(cause.message) : "Command failed"}\n`,
    );
    process.exitCode = 1;
  }
}
