import { fungiAccountCommandHelp } from "@fungi.computer/truffle";
import { agentsCommandHelp } from "./agents-command.js";
import { computerCommandHelp } from "./computer-command.js";
import { computersCommandHelp } from "./computers-command.js";
import { extensionCommandHelp } from "./extension-command.js";

/** Public help for the fungi command; internal commands answer only by name. */
const help = `Usage: fungi [command] [options]

Start here:
  fungi                          Open your conversations in this folder
  fungi new                      Start a new conversation
  fungi login                    Sign in to Fungi, a subscription or an API key

Conversations:
  fungi resume [--last]          Reopen a saved conversation
  fungi sessions <action>        List, resume or inspect saved conversations
  fungi agents <action>          List, archive or restore this folder's Agents
  fungi run [prompt]             Run one prompt and print the answer
  fungi acp                      Connect an editor (Zed, Neovim) via ACP

Account:
  fungi login                    Sign in to Fungi or another model provider
  fungi logout                   Sign out of a model provider
  fungi status                   Show what you're signed in to
  fungi account [teams|use-team <id>|balance]
                                 Read your Fungi account and choose its Team
  fungi doctor                   Check platform, sign-in and model readiness

Team Computers:
  fungi computers [start <name>]
                                 List or start your Team's Computers
  fungi computer <action>        Attach, inspect or detach a folder
  fungi mcp show|use|forget      Manage this project's Team MCP address

Fungi itself:
  fungi extension <action>       Add, list, remove, enable or disable extensions
  fungi stop                     Stop the local background service
  fungi reload                   Reload configuration for the next turn
  fungi update                   Update fungi to the latest release
  fungi help [command]           Show help for one command

Options:
  -h, --help                     Show help for fungi or a command
  -V, --version                  Print the fungi version
  -C, --cd <path>                Project folder (default: current folder)
      --extension <entry>        Enable an installed client extension
                                 (repeatable)
      --yes                      Skip setup prompts; continue local-only
      --require-sandbox          Require the Local sandbox for this Agent
      --no-require-sandbox       Allow fallback if its sandbox is unavailable

Choose models and thinking levels inside fungi with /model and /thinking.
Saved conversations remain after fungi stop.
`;

const sessionOptions = `  -C, --cd <path>                Project directory (default: current folder)
      --require-sandbox          Refuse work if the Local sandbox is unavailable
      --no-require-sandbox       Restore automatic attempt with fallback
      --fungi-mcp <url>          Select and remember a hosted Team Computer
      --extension <entry>
                                 Enable an installed client extension
                                 (repeatable)`;

const commandHelp = new Map<string, string>(
  Object.entries({
    acp: `Usage: fungi acp [-C dir]
       fungi acp login [login options]

Serve stable ACP over stdin/stdout for editors such as Zed. Sessions and work
belong to the shared Local service and survive editor disconnects. Sign in with
fungi login before prompting. Model selection belongs to the Local Agent.

  -C, --cd <path>                Project directory (default: current folder)

Editors launch fungi with args ["acp"]. Terminal authentication appends "login"
and uses the ordinary Fungi login flow.
`,
    doctor:
      "Usage: fungi doctor [-C dir]\n\nReport platform, glibc, saved sign-in, model availability, HTTP connectivity\nand installed version.\n",
    new: `Usage: fungi new [options]

Start a new conversation in this folder, skipping the conversation list.

  -C, --cd <path>                Project directory (default: current folder)
      --require-sandbox          Refuse work if the Local sandbox is unavailable
      --no-require-sandbox       Restore automatic attempt with fallback
      --extension <entry>        Enable an installed client extension
                                 (repeatable)
`,
    resume: `Usage: fungi resume [--last] [options]

Pick a saved Session in this project, or reopen the latest with --last.

      --last                     Resume the most recent local Session
${sessionOptions}
`,
    sessions: `Usage: fungi sessions list [-C dir]
       fungi sessions resume <number|session-id|prefix> [-C dir]
       fungi sessions resume --last [-C dir]
       fungi sessions show <id>|--last [-C dir] [--errors] [--json]
       fungi sessions status [id|--last] [-C dir] [--json]
       fungi sessions watch <id>|--last [-C dir] [--errors] [--json]

List the same recent-first Sessions as the TUI picker. Resume by the number,
full Session ID, or a unique ID prefix shown in the list; --last chooses the
latest. Show and watch inspect at most 100 messages through the authenticated
Local service. Status prints a stable schemaVersion 2 state for automation;
without an ID it selects the latest Session in this project.
`,
    run: `Usage: fungi run [prompt] [options]

Run one prompt in a local Session and print the answer. Reads the prompt from
stdin when it is omitted.

  -C, --cd <path>                Project directory (default: current folder)
      --require-sandbox          Refuse work if the Local sandbox is unavailable
      --no-require-sandbox       Restore automatic attempt with fallback
      --agent <id>               Agent to run in when the folder has several
      --fungi-mcp <url>          Give the Agent tools on a Team Computer
`,
    login: `Usage: fungi login
       fungi login --provider <id> [--auth-type oauth|api_key] [--method <id>]

In a terminal, fungi login asks how Shiitake should reach a model: your Fungi
account (recommended), your Claude or ChatGPT subscription, or an API key.
Without a terminal it starts the Fungi browser sign-in.

Signing in to Fungi opens your browser once and asks which Team pays for
models. The same account serves Team tools.

Claude Pro/Max over SSH: run fungi login --provider anthropic --auth-type oauth
and open the printed link on any machine. Then paste the authorization code or
the final redirect URL back into fungi.

      --provider <id>            Model provider, e.g. fungi, anthropic, openai
      --auth-type <type>         oauth (subscription) or api_key
      --method <id>              Provider login choice (browser or device-code)
      --hub <origin>             Fungi Hub (default: fungi.computer)
      --fungi-mcp <url>          Advanced: sign in to one Team MCP endpoint
`,
    status: `Usage: fungi status [--provider <id>]

Show your Fungi account and Team, then the model providers you're signed in to.

      --provider <id>            Show one model provider only
`,
    logout: `Usage: fungi logout [--provider <id>]
       fungi logout --fungi-mcp <url>

Log out of a model provider, or remove the saved Fungi MCP login for the
origin of <url> and ask that Fungi Hub to revoke it.

      --provider <id>            Model provider to log out of
      --fungi-mcp <url>          Team MCP endpoint or Fungi origin
`,
    serve: `Usage: fungi serve --workers <file> --listen <url>

Run a foreground worker server for programmatic clients.

      --workers <file>           Worker definitions
      --listen <url>             Listen address
`,
    update: `Usage: fungi update

Update fungi to the latest release of @fungi.computer/spore on npm. npm checks
the package integrity. fungi stops its background service first and restores
the previous version if the new one does not start. Saved conversations stay.
Installed with install.sh? Run the install command again instead.
`,
    "git-credential": `Usage: fungi git-credential remote|get|store|erase\n       --hub <origin> --team <id>

Git credential helper for a Fungi Team's tracker. Git runs it for you; it is
not meant to be run by hand.
`,
    reload: `Usage: fungi reload [-C <directory>]

Validate Team MCP connections, extension rosters and the invoking shell's PATH.
Configuration reloaded; applies from the next turn. In-flight turns keep their
captured configuration. Invalid input keeps the entire old configuration.
Changed versions/configuration of an existing extension need a restart:
run fungi stop, then reopen fungi.`,
    stop: `Usage: fungi stop

Stop the shared local background service. Saved Sessions remain.
`,
    mcp: `Usage: fungi mcp show [-C <path>]
       fungi mcp use <url> [--from-file -] [-C <path>]
       fungi mcp forget [-C <path>]

Show, switch, or forget this project's MCP endpoint. For an Oyster, use
--from-file - to read its oyk_ key from stdin, never a command-line argument.
The project stores only the address and authentication selection. Local owns
credentials; fungi login remains the Hub sign-in path. A running Local service
keeps its existing connection until fungi stop.
`,
    computer: computerCommandHelp,
    extension: extensionCommandHelp,
    computers: computersCommandHelp,
    agents: agentsCommandHelp,
    account: fungiAccountCommandHelp,
  }),
);

export function helpFor(command: string | undefined): string {
  if (command === undefined || command === "help") return help;
  const text = commandHelp.get(command);
  if (text === undefined) throw new Error(`Unknown fungi command: ${command}`);
  return text;
}
