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
import { resolve } from "node:path";
import {
  runComputersCommand,
  type ComputersCommandOwners,
} from "./computers-command.js";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
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
  type PrivateFungiAccountLoginOptions,
  type PrivateFungiAccountLogoutResult,
} from "@fungi.computer/truffle";
import {
  createPrivateLocalServiceManager,
  runPrivateLocalWorkerServer,
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

function authOptionsFromIo(io: FungiCliIo): TuiAuthCall {
  const options: TuiAuthCall = {};
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

function validateFungiCommand(
  command: string | undefined,
  positionals: readonly string[],
  last: boolean | undefined,
): void {
  if (
    command !== undefined &&
    command !== "resume" &&
    command !== "new" &&
    command !== "sessions" &&
    command !== "run" &&
    command !== "serve" &&
    command !== "stop" &&
    command !== "update" &&
    command !== "login" &&
    command !== "status" &&
    command !== "account" &&
    command !== "doctor" &&
    command !== "logout" &&
    command !== "computers" &&
    command !== "computer" &&
    command !== "extension" &&
    command !== "mcp" &&
    command !== "acp" &&
    command !== "help"
  )
    throw new Error(`Unknown fungi command: ${command}`);
  if (command === "help" && positionals.length > 1)
    throw new Error("fungi help accepts at most one command");
  if (command === "run" && positionals.length > 1)
    throw new Error("fungi run accepts at most one prompt");
  if (command === "update" && positionals.length > 0)
    throw new Error("fungi update does not accept positional arguments");
  if (last && command !== "resume" && command !== "sessions")
    throw new Error(
      "--last is only valid with fungi resume or fungi sessions resume",
    );
  if (command === "serve" && positionals.length > 0)
    throw new Error("fungi serve does not accept positional arguments");
  if (
    command === "computers" &&
    !(
      positionals.length === 0 ||
      (positionals.length === 2 && positionals[0] === "start")
    )
  )
    throw new Error("Usage: fungi computers | fungi computers start <name>");
  if (command === "computer") {
    const [action, ...rest] = positionals;
    const arity = { attach: 2, status: 0, detach: 1 } as const;
    const expected =
      action === "attach" || action === "status" || action === "detach"
        ? arity[action]
        : undefined;
    if (expected === undefined || rest.length !== expected)
      throw new Error(
        "Usage: fungi computer attach <computer> <folder> | status | detach <computer>",
      );
  }
  if (command === "account") {
    const [action, ...rest] = positionals;
    if (
      !(action === undefined && rest.length === 0) &&
      !((action === "teams" || action === "balance") && rest.length === 0) &&
      !(action === "use-team" && rest.length === 1)
    )
      throw new Error(
        "Usage: fungi account [--json] | teams [--json] | use-team <team-id> | balance [--json]",
      );
  }
  if (command === "extension") {
    const [action, ...rest] = positionals;
    const valid =
      (action === "add" && rest.length === 1) ||
      (action === "list" && rest.length === 0) ||
      (action === "remove" && rest.length === 1) ||
      ((action === "enable" || action === "disable") &&
        ((rest[0] === "project" && rest.length === 2) ||
          (rest[0] === "agent" && (rest.length === 2 || rest.length === 3))));
    if (!valid) throw new Error(extensionCommandHelp);
  }
  if (command === "mcp") {
    const [action, ...rest] = positionals;
    if (
      !((action === "show" || action === "forget") && rest.length === 0) &&
      !(action === "use" && rest.length === 1)
    )
      throw new Error("Usage: fungi mcp show | use <url> | forget");
  }
  if (command === "sessions") {
    const [action, target, ...rest] = positionals;
    if (
      rest.length > 0 ||
      (action !== "list" &&
        action !== "resume" &&
        action !== "show" &&
        action !== "status" &&
        action !== "watch") ||
      (action === "list" && (target !== undefined || last)) ||
      (action === "resume" &&
        ((target === undefined && !last) || (target !== undefined && last))) ||
      ((action === "show" || action === "watch") &&
        ((target === undefined && !last) || (target !== undefined && last))) ||
      (action === "status" && target !== undefined && last)
    )
      throw new Error(
        "Usage: fungi sessions list | resume <number|session-id|prefix>|--last | show|watch <id>|--last | status [id|--last]",
      );
    if (
      action === "resume" &&
      target !== undefined &&
      /^[0-9]+$/u.test(target) &&
      (!/^[1-9][0-9]*$/u.test(target) || !Number.isSafeInteger(Number(target)))
    )
      throw new Error(
        "Session number must be a positive integer from fungi sessions list",
      );
  }
  if (
    (command === "login" || command === "status" || command === "logout") &&
    positionals.length > 0
  )
    throw new Error(`fungi ${command} does not accept positional arguments`);
}

function validateFungiAuthOptions(
  command: string | undefined,
  values: Readonly<{
    cd?: string | undefined;
    connect?: string | undefined;
    db?: string | undefined;
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
): Promise<void> {
  const arguments_ = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      db: { type: "string" },
      extension: { type: "string", multiple: true },
      "fungi-mcp": { type: "string" },
      "host-label": { type: "string" },
      hub: { type: "string" },
      team: { type: "string" },
      yes: { type: "boolean" },
      model: { type: "string", short: "m" },
      provider: { type: "string" },
      "auth-type": { type: "string" },
      reasoning: { type: "string" },
      cd: { type: "string", short: "C" },
      last: { type: "boolean" },
      connect: { type: "string" },
      listen: { type: "string" },
      workers: { type: "string" },
      method: { type: "string" },
      errors: { type: "boolean" },
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
      overrides.extensions ?? localExtensions(),
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
  if (arguments_.values.help) {
    stdout.write(helpFor(command));
    return;
  }
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
  validateFungiCommand(command, positionals, arguments_.values.last);
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
      hub ??
        (await (overrides.readFungiStatus ?? readFungiAccountStatus)())
          ?.issuer ??
        "https://fungi.computer",
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
  let fungiMcp = endpoint === undefined ? undefined : { endpoint };
  if (command === "doctor") {
    if (positionals.length > 0)
      throw new Error("fungi doctor does not accept positional arguments");
    const selected = await readProjectMcpConnection(
      resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? "."),
    );
    const passed = await runDoctor({
      models: io.authModels ?? createPrivateModels(),
      fungiAccount: overrides.readFungiStatus ?? readFungiAccountStatus,
      endpoint: selected,
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
  if (command === "stop") {
    if (positionals.length > 0 || Object.keys(arguments_.values).length > 0)
      throw new Error("fungi stop does not accept arguments or options");
    const manager =
      overrides.createServiceManager?.() ??
      (
        await import("@fungi.computer/truffle/service")
      ).createPrivateLocalServiceManager();
    const stopped = await manager.stop();
    linearCli.info(
      stopped.kind === "not-running"
        ? stopped.recordCleaned
          ? "Local service wasn't running; cleaned up its record. Saved Sessions preserved."
          : "Local service wasn't running. Saved Sessions preserved."
        : stopped.kind === "replaced"
          ? "Local service was replaced; left the new service running."
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
      { json: arguments_.values.json === true, stdout },
    );
    return;
  }
  if (command === "mcp") {
    const invalid = Object.keys(arguments_.values).filter(
      (key) => key !== "cd",
    );
    if (invalid.length > 0)
      throw new Error("fungi mcp accepts only -C or --cd");
    const root = resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? ".");
    if (positionals[0] === "use" && positionals[1] !== undefined) {
      const selected = await saveProjectMcpConnection(root, positionals[1]);
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
          : `Team MCP for ${root}: ${selected}\n`,
      );
    }
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
    const manager =
      overrides.createServiceManager?.() ?? createPrivateLocalServiceManager();
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
    const savedEndpoint = await readProjectMcpConnection(invocationRoot);
    await runTuiCli(
      {
        invocationRoot,
        sessionChoice: selected,
        clients: sessionClients,
        ...(await projectExtensions(invocationRoot, undefined)),
        fungiMcp:
          savedEndpoint === undefined ? undefined : { endpoint: savedEndpoint },
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
      (await readProjectMcpConnection(
        resolve(io.cwd ?? process.cwd(), arguments_.values.cd ?? "."),
      ));
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
        list: listPrivateTeamComputers,
        start: startPrivateTeamComputer,
        ...overrides.computersOwners,
      },
    );
    return;
  }
  if (command === "extension") {
    for (const name of Object.keys(arguments_.values))
      if (name !== "cd")
        throw new Error(`--${name} is not valid with fungi extension`);
    const [action, ...rest] = positionals;
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
      },
      overrides.extensions ?? localExtensions(),
    );
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
        attach: attachPrivateLocalComputer,
        detach: detachPrivateLocalComputer,
        list: listPrivateLocalComputers,
        run: runPrivateLocalComputer,
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
        const result = await (overrides.signOutFungi ?? signOutFungiAccount)(
          signInEndpoint,
        );
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
      await (overrides.signInFungi ?? signInFungiAccount)(
        signInEndpoint,
        loginOptions,
      );
      stdout.write(
        "Fungi login complete. Models and Team MCP use this account.\n",
      );
      return;
    }
    if (command === "logout" && arguments_.values.provider === "fungi") {
      const result = await (overrides.signOutFungi ?? signOutFungiAccount)();
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
    const authCall = authOptionsFromIo(io);
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
      const models = authCall.models ?? createPrivateModels();
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
      const login = await (
        overrides.readFungiStatus ?? readFungiAccountStatus
      )();
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
    listen: arguments_.values.listen,
    provider: arguments_.values.provider,
    model: arguments_.values.model,
    reasoning,
  });
  const invocationRoot = resolve(
    io.cwd ?? process.cwd(),
    arguments_.values.cd ?? ".",
  );
  if (fungiMcp === undefined) {
    const savedEndpoint = await readProjectMcpConnection(invocationRoot);
    if (savedEndpoint !== undefined) fungiMcp = { endpoint: savedEndpoint };
  }
  const common = {
    fungiMcp,
    invocationRoot,
    databasePath: arguments_.values.db,
    providerId: arguments_.values.provider,
    modelId: arguments_.values.model,
    reasoning,
  };
  const models = () => io.authModels ?? createPrivateModels();
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
          prompt: positionals[0],
          stdin: io.stdin,
          stdout: io.stdout,
          signals: io.signals,
          connect: arguments_.values.connect,
        },
        overrides,
      );
    } catch (cause) {
      if (await modelLoginMissing(models(), arguments_.values.provider))
        process.stderr.write(`${fungiModelLoginNotice}\n`);
      throw cause;
    }
  } else {
    if (command === "resume" && arguments_.values.connect === undefined) {
      const manager =
        overrides.createServiceManager?.() ??
        createPrivateLocalServiceManager();
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
      overrides,
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
async function confirm(io: FungiCliIo, question: string): Promise<boolean> {
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
  const answer = await cli.confirm({ message: question, initialValue: false });
  return !isCancel(answer) && answer;
}

function validateFungiConnectionOptions(
  command: string | undefined,
  last: boolean | undefined,
  options: Readonly<{
    cd: string | undefined;
    connect: string | undefined;
    db: string | undefined;
    listen: string | undefined;
    provider: string | undefined;
    model: string | undefined;
    reasoning: string | undefined;
  }>,
): void {
  validateFungiListenerMode(command, last, options.listen);
  validateFungiConnectedMode(command, last, options);
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "--internal-service") {
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
