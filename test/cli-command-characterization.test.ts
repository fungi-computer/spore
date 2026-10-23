import assert from "node:assert/strict";
import { test } from "bun:test";
import { runFungiCli } from "../src/cli.js";

type CommandForm = Readonly<{
  args: readonly string[];
  last?: true;
}>;

// These are observations of the existing CLI, not a new command specification.
// Exercise the real parseArgs -> validateFungiCommand caller. Pair valid grammar
// with an incompatible option so its next error proves grammar admission without
// starting a Session, installing extensions, contacting a server or updating fungi.
// These are NOT successful-dispatch proofs; cli-grammar.test.ts covers dispatch.
const accepted: readonly CommandForm[] = [
  { args: [] },
  { args: ["new"] },
  { args: ["new", "extra", "positionals"] },
  { args: ["resume"] },
  { args: ["resume", "session-id"] },
  { args: ["resume", "extra", "positionals"], last: true },
  { args: ["resume"], last: true },
  { args: ["run"] },
  { args: ["run", "one prompt with spaces"] },
  { args: ["run", ""] },
  { args: ["help"] },
  { args: ["help", "sessions"] },
  { args: ["help", "unknown-topic"] },
  { args: ["serve"] },
  { args: ["stop"] },
  { args: ["stop", "extra", "positionals"] },
  { args: ["reload"] },
  { args: ["reload", "extra", "positionals"] },
  { args: ["update"] },
  { args: ["login"] },
  { args: ["status"] },
  { args: ["logout"] },
  { args: ["doctor"] },
  { args: ["doctor", "extra", "positionals"] },
  { args: ["acp"] },
  { args: ["acp", "extra", "positionals"] },
  { args: ["computers"] },
  { args: ["computers", "start", "name"] },
  { args: ["computers", "start", ""] },
  { args: ["computer", "attach", "computer", "folder"] },
  { args: ["computer", "attach", "", ""] },
  { args: ["computer", "status"] },
  { args: ["computer", "detach", "computer"] },
  { args: ["account"] },
  { args: ["account", "teams"] },
  { args: ["account", "balance"] },
  { args: ["account", "use-team", "team-id"] },
  { args: ["account", "use-team", ""] },
  { args: ["extension", "add", "npm-spec"] },
  { args: ["extension", "add", ""] },
  { args: ["extension", "list"] },
  { args: ["extension", "remove", "id"] },
  { args: ["extension", "enable", "project", "id"] },
  { args: ["extension", "disable", "project", "id"] },
  { args: ["extension", "enable", "agent", "id"] },
  { args: ["extension", "enable", "agent", "id", "store"] },
  { args: ["extension", "disable", "agent", "id"] },
  { args: ["extension", "disable", "agent", "id", "store"] },
  { args: ["extension", "enable", "skills", "id"] },
  { args: ["extension", "enable", "skills", "id", "store"] },
  { args: ["extension", "disable", "skills", "id"] },
  { args: ["extension", "disable", "skills", "id", "store"] },
  { args: ["mcp", "show"] },
  { args: ["mcp", "forget"] },
  { args: ["mcp", "use", "https://example.test/mcp"] },
  { args: ["mcp", "use", ""] },
  { args: ["agents", "list"] },
  { args: ["agents", "archive", "agent-id"] },
  { args: ["agents", "unarchive", "agent-id"] },
  { args: ["sessions", "list"] },
  { args: ["sessions", "resume", "1"] },
  { args: ["sessions", "resume", "9007199254740991"] },
  { args: ["sessions", "resume", "session-id"] },
  { args: ["sessions", "resume", "prefix"] },
  { args: ["sessions", "resume", ""] },
  // Only all-decimal selectors are interpreted as listed session numbers.
  { args: ["sessions", "resume", "1.5"] },
  { args: ["sessions", "resume", "1e3"] },
  { args: ["sessions", "resume", "-1"] },
  { args: ["sessions", "resume"], last: true },
  { args: ["sessions", "show", "id"] },
  { args: ["sessions", "show", "0"] },
  { args: ["sessions", "show"], last: true },
  { args: ["sessions", "watch", "id"] },
  { args: ["sessions", "watch", "01"] },
  { args: ["sessions", "watch"], last: true },
  { args: ["sessions", "status"] },
  { args: ["sessions", "status", "id"] },
  { args: ["sessions", "status", "0"] },
  { args: ["sessions", "status"], last: true },
];

const lastError =
  "--last is only valid with fungi resume or fungi sessions resume";
const computersError = "Usage: fungi computers | fungi computers start <name>";
const computerError =
  "Usage: fungi computer attach <computer> <folder> | status | detach <computer>";
const accountError =
  "Usage: fungi account [--json] | teams [--json] | use-team <team-id> | balance [--json]";
const mcpError = "Usage: fungi mcp show | use <url> | forget";
const sessionsError =
  "Usage: fungi sessions list | resume <number|session-id|prefix>|--last | show|watch <id>|--last | status [id|--last]";
const numberError =
  "Session number must be a positive integer from fungi sessions list";

// Literal copies deliberately pin the entire error, including trailing newline.
const agentsError = `Usage: fungi agents list [--archived] [-C dir]
       fungi agents archive <agent-id> [-C dir]
       fungi agents unarchive <agent-id> [-C dir]

List this folder's Agents with their ids, or archive one to tidy up. An archived
Agent leaves fungi, the Agent picker, agents.list and delegation, and cannot be
sent work; its conversations and files stay on disk. fungi agents list
--archived shows the archived Agents, and unarchive restores one everywhere.
Archiving is refused while the Agent has a running command; cancel it first.
`;
const extensionError = `Usage: fungi extension add <git-url | npm-spec | path> [--skills | --no-skills]
       fungi extension list
       fungi extension remove <id>
       fungi extension enable project <id>
       fungi extension enable agent <id> [<agent-store>]
       fungi extension enable skills <id> [<agent-store>]
       fungi extension disable project|agent|skills <id> [<agent-store>]

Install an extension once for your user, then enable its parts where you want
them. "project" adds its client part and programs to Open pane in this folder,
for whichever Agent you chat with. "agent" grants one Agent store the tools and
capabilities the extension declares; that Agent uses them from its next start.
Installed extensions are trusted code that runs as you. A Git source is pinned
to the commit it resolved; run add again to update.
An extension may ship skills. add lists them and asks whether to add them for
this folder's Agent (--skills says yes and --no-skills says no, without asking).
Skills are read in place from the installed extension, show as "from <id>", and
yours with the same name win. "disable agent" and "remove" take them away too.
`;

const refused: readonly (CommandForm & Readonly<{ error: string }>)[] = [
  { args: [""], error: "Unknown fungi command: " },
  { args: ["RUN"], error: "Unknown fungi command: RUN" },
  { args: ["unknown"], error: "Unknown fungi command: unknown" },
  { args: ["unknown"], last: true, error: "Unknown fungi command: unknown" },
  {
    args: ["help", "one", "two"],
    error: "fungi help accepts at most one command",
  },
  {
    args: ["help", "one", "two"],
    last: true,
    error: "fungi help accepts at most one command",
  },
  {
    args: ["run", "one", "two"],
    error: "fungi run accepts at most one prompt",
  },
  {
    args: ["run", "one", "two"],
    last: true,
    error: "fungi run accepts at most one prompt",
  },
  {
    args: ["update", "extra"],
    error: "fungi update does not accept positional arguments",
  },
  {
    args: ["update", "extra"],
    last: true,
    error: "fungi update does not accept positional arguments",
  },
  {
    args: ["serve", "extra"],
    error: "fungi serve does not accept positional arguments",
  },
  { args: ["serve", "extra"], last: true, error: lastError },
  { args: ["computers", "start"], error: computersError },
  { args: ["computers", "other"], error: computersError },
  { args: ["computers", "start", "name", "extra"], error: computersError },
  { args: ["computer"], error: computerError },
  { args: ["computer", "other"], error: computerError },
  { args: ["computer", "attach"], error: computerError },
  { args: ["computer", "attach", "computer"], error: computerError },
  {
    args: ["computer", "attach", "computer", "folder", "extra"],
    error: computerError,
  },
  { args: ["computer", "status", "extra"], error: computerError },
  { args: ["computer", "detach"], error: computerError },
  { args: ["computer", "detach", "computer", "extra"], error: computerError },
  { args: ["account", "other"], error: accountError },
  { args: ["account", "teams", "extra"], error: accountError },
  { args: ["account", "balance", "extra"], error: accountError },
  { args: ["account", "use-team"], error: accountError },
  { args: ["account", "use-team", "team", "extra"], error: accountError },
  { args: ["extension"], error: extensionError },
  { args: ["extension", "other"], error: extensionError },
  { args: ["extension", "add"], error: extensionError },
  { args: ["extension", "add", "spec", "extra"], error: extensionError },
  { args: ["extension", "list", "extra"], error: extensionError },
  { args: ["extension", "remove"], error: extensionError },
  { args: ["extension", "remove", "id", "extra"], error: extensionError },
  { args: ["extension", "enable"], error: extensionError },
  { args: ["extension", "disable"], error: extensionError },
  { args: ["extension", "enable", "other", "id"], error: extensionError },
  { args: ["extension", "disable", "other", "id"], error: extensionError },
  { args: ["extension", "enable", "project"], error: extensionError },
  { args: ["extension", "disable", "project"], error: extensionError },
  {
    args: ["extension", "enable", "project", "id", "store"],
    error: extensionError,
  },
  {
    args: ["extension", "disable", "project", "id", "store"],
    error: extensionError,
  },
  { args: ["extension", "enable", "agent"], error: extensionError },
  { args: ["extension", "disable", "agent"], error: extensionError },
  {
    args: ["extension", "enable", "agent", "id", "store", "extra"],
    error: extensionError,
  },
  {
    args: ["extension", "disable", "agent", "id", "store", "extra"],
    error: extensionError,
  },
  { args: ["extension", "enable", "skills"], error: extensionError },
  { args: ["extension", "disable", "skills"], error: extensionError },
  {
    args: ["extension", "enable", "skills", "id", "store", "extra"],
    error: extensionError,
  },
  {
    args: ["extension", "disable", "skills", "id", "store", "extra"],
    error: extensionError,
  },
  { args: ["mcp"], error: mcpError },
  { args: ["mcp", "other"], error: mcpError },
  { args: ["mcp", "show", "extra"], error: mcpError },
  { args: ["mcp", "forget", "extra"], error: mcpError },
  { args: ["mcp", "use"], error: mcpError },
  { args: ["mcp", "use", "url", "extra"], error: mcpError },
  { args: ["agents"], error: agentsError },
  { args: ["agents", "other"], error: agentsError },
  { args: ["agents", "list", "extra"], error: agentsError },
  { args: ["agents", "archive"], error: agentsError },
  { args: ["agents", "unarchive"], error: agentsError },
  { args: ["agents", "archive", "id", "extra"], error: agentsError },
  { args: ["agents", "unarchive", "id", "extra"], error: agentsError },
  { args: ["sessions"], error: sessionsError },
  { args: ["sessions", "other"], error: sessionsError },
  { args: ["sessions", "list", "id"], error: sessionsError },
  { args: ["sessions", "list"], last: true, error: sessionsError },
  { args: ["sessions", "resume"], error: sessionsError },
  { args: ["sessions", "resume", "id"], last: true, error: sessionsError },
  { args: ["sessions", "resume", "id", "extra"], error: sessionsError },
  { args: ["sessions", "resume", "0"], error: numberError },
  { args: ["sessions", "resume", "00"], error: numberError },
  { args: ["sessions", "resume", "01"], error: numberError },
  { args: ["sessions", "resume", "9007199254740992"], error: numberError },
  {
    args: ["sessions", "resume", "9999999999999999999999999999999"],
    error: numberError,
  },
  // The conflicting selector wins before numeric validation.
  { args: ["sessions", "resume", "0"], last: true, error: sessionsError },
  { args: ["sessions", "show"], error: sessionsError },
  { args: ["sessions", "show", "id"], last: true, error: sessionsError },
  { args: ["sessions", "show", "id", "extra"], error: sessionsError },
  { args: ["sessions", "watch"], error: sessionsError },
  { args: ["sessions", "watch", "id"], last: true, error: sessionsError },
  { args: ["sessions", "watch", "id", "extra"], error: sessionsError },
  { args: ["sessions", "status", "id"], last: true, error: sessionsError },
  { args: ["sessions", "status", "id", "extra"], error: sessionsError },
  {
    args: ["login", "extra"],
    error: "fungi login does not accept positional arguments",
  },
  {
    args: ["status", "extra"],
    error: "fungi status does not accept positional arguments",
  },
  {
    args: ["logout", "extra"],
    error: "fungi logout does not accept positional arguments",
  },
  { args: ["login", "extra"], last: true, error: lastError },
];

async function expectError(
  form: CommandForm,
  flags: readonly string[],
  message: string,
) {
  let output = "";
  await assert.rejects(
    runFungiCli(
      [...flags, ...(form.last ? ["--last"] : []), "--", ...form.args],
      {
        interactive: false,
        stdout: {
          write(chunk) {
            output += String(chunk);
            return true;
          },
        },
      },
    ),
    { name: "Error", message },
  );
  assert.equal(output, "");
}

for (const form of accepted) {
  test(`grammar admits ${JSON.stringify(form)} before incompatible options`, async () => {
    const extension = form.args[0] === "extension";
    await expectError(
      form,
      extension ? ["--provider", "fixture"] : ["--skills"],
      extension
        ? `--provider is not valid with fungi extension ${form.args[1] ?? ""}`
        : "--skills and --no-skills are only valid with fungi extension add",
    );
  });
}

for (const form of refused) {
  test(`grammar refuses ${JSON.stringify(form.args)} (last=${String(form.last)}) with the exact prior error`, async () => {
    await expectError(form, [], form.error);
  });
}

for (const command of [
  undefined,
  "new",
  "run",
  "help",
  "serve",
  "stop",
  "reload",
  "update",
  "login",
  "status",
  "logout",
  "doctor",
  "acp",
  "computers",
  "computer",
  "account",
  "extension",
  "mcp",
  "agents",
]) {
  test(`--last remains invalid with ${command ?? "the bare CLI"}`, async () => {
    await expectError(
      { args: command === undefined ? [] : [command], last: true },
      [],
      lastError,
    );
  });
}

test("credential subcommands still validate their own earlier boundary", async () => {
  await expectError(
    { args: ["account", "prepare-credential"] },
    [],
    "Usage: fungi account prepare-credential --provider anthropic|openai",
  );
  await expectError(
    { args: ["account", "use-credential"] },
    [],
    "Usage: fungi account use-credential --provider anthropic|openai --from-file -",
  );
});
