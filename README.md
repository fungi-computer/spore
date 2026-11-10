# Spore by Fungi (`@fungi.computer/spore`)

Fungi is an open-source workspace for AI agents: Apps that people and agents
both use, Computers that keep their files, and permissions the system checks.
Try it with one command, run it on your own Cloudflare account, or let us host
it.

Shiitake by Fungi is a coding agent that works in your project folder, on your
own Claude or ChatGPT subscription. Spore installs it as the `fungi` command,
for your terminal or an ACP editor such as Zed.

## Install and start

You need Node 22.13 or newer on Linux (x64 or arm64, glibc 2.35+) or macOS 13.5+
(Apple Silicon or Intel). Then, in your project folder:

```sh
npm install -g @fungi.computer/spore
fungi
```

Choose **Use my Claude or ChatGPT subscription**, finish the provider's browser
sign-in, then return to the terminal and send a prompt. You can also choose an
API key or Fungi models. A Fungi account is optional with your own subscription.
Run `fungi doctor` to check setup; unfinished steps say SETUP and give the next
command. To retry a cancelled sign-in, run `fungi login`.

For hosted models, run `fungi login --provider fungi` and choose the Team that
pays for models. Hosted models need Team credit. Login does not change an
existing Session's model selection.

Inside the terminal, `/model` chooses a model and `/thinking` selects a
supported level. **Use agent model** clears the Session override. Choices are
validated by Local without replacing the conversation. Fungi model use is
metered to the selected Team. Your own provider bills key/subscription work.
Local files, tools and Session storage are on your machine. Prompts and context
go to the selected model provider; local storage is not a no-retention
guarantee.

`/permissions` shows the current Agent's mode and this project's Always-allow
rules. Enter keeps the current mode. Switching to Full access needs a separate
confirmation, as does removing a saved rule; both confirmations default to
keeping the current permissions. Rules are shared by Workspace Agents in the
project, while the mode belongs to the selected Agent.

`fungi login` opens the model-provider chooser in a terminal. Choose a provider
directly with `fungi login --provider <id>` or `/login` inside a conversation. A
Fungi sign-in refusal asks for another login, a credit refusal names the Team to
fund, and a paused or unreachable service requires retrying when available.
Fungi failure does not fall back to another model provider.

## Work, resume and recover

Enter sends a prompt. While work runs, Enter steers and Tab queues a follow-up.
Shift+Enter or Alt+Enter inserts a newline. Acceptance is not task completion.
Inspect the final reply and actual files before relying on the result.

Illustrative: the resume commands need saved Sessions in the selected project.

```sh
fungi sessions list
fungi sessions resume 1
fungi resume --last
fungi sessions status --json
```

Use `-C <project>` to select another folder. Resume accepts a list number, full
Session ID or unique ID prefix. `sessions show --last` reads bounded history.
`sessions watch --last` follows live state through the Local service.

Type `/` to discover commands. `/help` and `/keys` show available actions and
bindings. Escape dismisses a visible toast first, then a dialog or suggestions.
Otherwise, it withdraws a waiting prompt or cancels active work. `/cancel`
requests that withdrawal or cancellation directly. Ctrl+C dismisses an open
dialog first. With a waiting prompt, it exits the client and leaves the prompt
queued. During active work, the first Ctrl+C requests cancellation. A second
Ctrl+C exits even while cancellation is pending. Ctrl+C also exits an idle
client. `/exit` closes the terminal client. `/reconnect` repairs history
observation, not execution. `/retry` resends the failed instruction. `/continue`
asks for new continuation work. Check partial changes before either action.

Closing the terminal leaves the shared local service running. `fungi stop` stops
it for every local client while retaining saved Sessions. The next launch starts
it again. Project data lives in `.fungi/`. Credentials live in the same user's
home configuration. Do not share credential files.

When an open Session loses the service for more than a second (`fungi stop`, an
update, a crash), the pane shows "Restarting the service... your session will
resume" and retries with a bounded backoff. Each retry re-reads
`~/.fungi/service/service.json`, so a service that returns on a new port or id
is found; it never starts a service itself. The Session reopens where it was:
the draft stays and history is not duplicated. A loss that heals within a second
shows nothing. After thirty seconds the overlay says the service is not
answering and to run `fungi resume` in another terminal; the pane keeps retrying
and resumes by itself once the service is back.

Tool rows show the same sigils as Parakeet. The default `"sigils": "auto"`
enables images only in kitty (`TERM=xterm-kitty` or `TERM_PROGRAM=kitty`),
Ghostty (`TERM=xterm-ghostty` or `TERM_PROGRAM=ghostty`), or Herdr
(`HERDR_ENV=1`), and only when the native Kitty graphics probe succeeds before
the device-attributes reply. All other terminals keep text rows, even if they
support Kitty graphics.

Set `"sigils": "on"` in `~/.config/fungi/tui.json` to opt an unrecognized
terminal into images; it still requires a successful graphics probe. Use this
only when your terminal supports Kitty Unicode placeholders. Set
`"sigils": "off"` in the same file or launch with `FUNGI_TUI_SIGILS=off` to
disable images; the environment off switch also overrides `"on"`. Sigils scroll
with the rows and are omitted from copied text; duration and disclosure carets
keep a fixed column.

Terminal diagnostics go to `~/.fungi/logs/tui.jsonl`, never directly to the
terminal frame. Client extension failures also appear as a notice in the frame.
The log records timestamp, process ID, operation and error class with redacted
causes, retaining at most 1 MiB plus one rotation (`tui.jsonl.1`). Failed
display-code formatting keeps the original code readable.

## ACP editors

`fungi acp` serves a Local Agent over stdin/stdout. It uses the same project,
Session store and background service as the terminal. Closing an editor detaches
its client; it does not cancel accepted work or delete history. Stop work with
the editor's Cancel action. Stop the background service with `fungi stop`.

Sign in with `fungi login` and choose the Team that pays for hosted models.
Model selection belongs to the Local Agent and its saved Session preferences.
ACP does not silently choose a different provider when a login or model fails.

Run the editor under the same OS account and home directory. To change its
Session's model, find it with `fungi sessions list`, open it with
`fungi sessions resume <session-id>`, and use `/model` in the terminal. Use
`/exit` to return to the editor. ACP does not expose a model picker.

The [editor guide](https://docs.fungi.computer/guides/use-fungi-in-your-editor/)
covers Zed, Neovim with Agentic.nvim, cancellation and history.

In Zed's user settings, add:

```json
{
  "agent_servers": {
    "fungi": {
      "type": "custom",
      "command": "fungi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Open the Agent panel, choose Fungi from the new-thread menu, and send a prompt.
Zed supplies the project directory. Use Thread History to import saved Fungi
Sessions; reopening a thread loads its durable messages. `dev: open acp logs`
shows protocol diagnostics. Keep credentials out of editor settings.

An editor that supports terminal authentication can open the existing login
flow: ACP appends `login` to the configured arguments, invoking
`fungi acp login`. Other ACP clients can sign in with `fungi login` beforehand.
`-C <project>` sets the discovery root when a client lists Sessions without a
project directory.

The Local door supports text, images, embedded text and image resources, and
resource links. Local tools own filesystem access. Additional directories and
editor-supplied MCP servers are refused. `fungi acp` serves the Local Agent, not
a hosted Team Agent.

## Team Computers and attached folders

`fungi login --fungi-mcp <url>` opens Fungi browser approval for a Team
endpoint. `fungi --fungi-mcp <url>` selects those tools for a local Session. The
project remembers only the address. `fungi mcp show|use|forget` manages that
selection. Stop the service before replacing its live connection. MCP and hosted
models share one Fungi account login. The model's selected billing Team and the
project's Computer endpoint remain separate choices.

`fungi account [--json]` reads that login without printing credentials: the Hub,
the Team that pays for models and when access expires. `fungi account teams`
lists current memberships, `fungi account use-team <id>` switches to one (a Team
you no longer belong to is refused and the prior Team stays), and
`fungi account balance` reads the paying Team's credit when you may see its
billing. A Hub that does not admit Local sign-ins for billing replies
`{"kind":"not-available"}` instead.

`fungi computers` lists the Team's Computers. `fungi computers start <name>`
starts an existing one through funding and capacity admission. Cancelling the
local wait does not undo a start already accepted by the Hub.

`fungi computer attach <name> <folder> --fungi-mcp <url>` is separate. It admits
commands to your machine as your OS user and syncs files both ways while the
command runs. Review its confirmation notice. The Computer's version wins
conflicting offline edits. Ctrl+C disconnects. Re-run to reconnect. Attachment
needs Node 22.13 or newer. The folder path and device private key stay local.
`computer detach` removes the attachment. Fungi logout attempts detach through
Local's shared sign-out owner, then removes local credentials even if remote
cleanup cannot be confirmed. Its warning names affected Computers and their Hub
Computers pages; a running backend can still serve until detached or stopped.
Pending cleanup retries after the next successful same-account sign-in. See
[account and logout recovery](https://docs.fungi.computer/account/sign-in/).

`fungi vm` opens fungi inside a [Lima](https://lima-vm.io/) Linux VM that mounts
only the current folder, creating or starting it first. `fungi vm login`,
`fungi vm stop` and `fungi vm rm` sign in, stop and delete it. Lima owns the VM;
every `limactl` command is printed before it runs. See
[Run Fungi in its own VM](https://docs.fungi.computer/guides/run-fungi-in-a-vm/).

## Extensions

```sh
fungi extension add git+https://github.com/you/fungi-counter.git#v1
fungi extension enable project counter
fungi extension enable agent counter
```

`add` installs the package once for your user and pins a Git source to its
commit. `enable project` puts the extension's programs in **Open pane** and its
client part in this folder's TUI, for whichever Agent you chat with; restart
`fungi` to see them. `enable agent` grants the folder's Agent the tools the
extension declares (name the store when the folder has several); the Agent uses
them from its next start, and running work is never interrupted. Opening a
program grants no tools. `disable` and `remove` withdraw access the same way. An
extension program runs in a terminal pane like a local shell, and closing the
pane ends it. The [extension pane test](test/extension-program-pane.test.tsx)
installs a Git fixture, opens its program from **Open pane** and drives it
through the granted Agent's `execute`.

## Conversation panes

`/new` starts a fresh conversation in the current pane, preserving its position
and closing only the previous observation. Explicit new-pane commands open
additional panes. `/resume` opens or focuses a saved conversation. `Ctrl K x`
closes the focused pane. `Ctrl K` shows the pane commands; press it again to
search commands. `Alt+Left` / `Alt+Right` focus panes, `Alt+Shift+Left` /
`Alt+Shift+Right` swap them, and `Alt+Enter` toggles zoom. The palette also
offers horizontal/vertical splitting and main-pane resizing. `Ctrl K x` releases
only the focused view and its client; it never aborts Session work. Closing the
last pane leaves the shell and its open/exit commands.

Searchable pickers use fuzzy matching over names and descriptions: `zp` finds
**Zoom pane**, and `clp` finds **Close pane**. Matched letters are bold; accents
and joined emoji stay whole when highlighted.

Slash completion starts with available conversation commands. Stop appears while
work is active or waiting; retry and continue appear when their existing
recovery conditions apply. Settings remain reachable by their typed slash names.
Advanced commands, such as `/session`, appear only when their alias prefix is
typed. Pane controls and Row actions live in the command picker, not slash
completion.

### App Gills

Choose **Open pane → Apps** (`Ctrl K o`). Apps with declared Gills open a text
pane; Apps without Gills open their admitted full UI in your browser. Sign in to
Fungi and select a Team first; until then **Open pane** does not list Apps.
Local owns credentials and fresh App selectors; panes receive neither tokens nor
App invocation authority.

In a Gill, Up/Down selects a row and Enter executes its declared action before
replacing the current pane with its typed Session target as an ordinary
conversation. Only explicit pane commands open additional panes. **R**
refreshes, **O** opens the full App, and **N/B** moves to the next/first page
when available. Those commands are scoped to the focused pane. Returning focus
refreshes the Gill. A transient failure keeps Refresh; a permanent environment
refusal offers only the full App. Closing or leaving the pane aborts pending
view/action reads, without undoing a visit already committed by its owner or
cancelling durable Session work. A selected-Team change refuses the retired
account's late reads.

## Local terminal pane

Choose **Open pane → Local terminal** (`Ctrl K o`, then Enter) to run your login
shell in this CLI's working directory: `$SHELL`, else your account's passwd
shell, else `/bin/sh`, each only when it is an absolute path to an executable.
It starts as an interactive login shell, so your profile and rc files load. This
is a shell on your machine, with your user account's filesystem and OS access.
It is not a Team Computer or a sandbox. Linux uses the existing Bun 1.4.4
`setsid`, `ps` and `pkill` path. On macOS the pane owns an `@opencode-ai/pty`
0.3.0 daemon and its controlling PTY; the React pane mounts OpenTUI 0.5.10's
`EmbeddedTerminalRenderable` directly instead of projecting another cell grid.
The authenticated protocol-7 transport is retained from OpenCode revision
`165cd2e832574ccdea3b311fe1a0f9db2e5c883e` with its license in
`src/button/opencode-pty-transport.LICENSE`.

Like any terminal, the shell inherits the environment the TUI was started with,
including `SSH_AUTH_SOCK` and your PATH, less only the variables Fungi's
launcher sets for its own process (`FUNGI_BUNDLED_CLI`,
`FUNGI_BUNDLED_BUILD_ID`, `FUNGI_LAUNCHER`, `FUNGI_LAUNCHER_NODE`,
`FUNGI_NODE`); TERM is set by the host. Programs can still access files and
credentials available to your OS user. No Agent command, remote endpoint or Gill
action can open or type into it.

Ctrl-C interrupts its foreground job when the pane is focused. Ctrl K opens the
shared pane commands; Ctrl K again opens the command list. **Send Ctrl K to
shell** sends Ctrl K to a program that needs it. Resizing a pane resizes its
PTY. Closing a shell with running jobs asks for confirmation and terminates its
PTY session's jobs; an idle shell closes at once. Exiting the shell leaves its
final grid visible with an exit-status overlay. Panes have no host title row;
terminal programs use every row, without a location header or reserved footer.
Only a divider between neighbouring panes takes a column. A program's own UI is
unchanged. Programs that deliberately detach into another OS session remain
ordinary user-owned processes, outside that terminal session. If the TUI is
killed with SIGKILL (`kill -9`), cleanup cannot run and background jobs can be
orphaned. Human quit asks when a shell has child jobs, with **Keep shells
running** selected by default; **Quit and terminate** exits and cleans up the
sessions. An idle shell does not prompt. SIGTERM, SIGHUP and Team retirement
still terminate sessions without an interactive confirmation.

## Team issue tracker over Git

After the Team owner enables its issue tracker repository, all current members
can clone and push with their Botanical login. Sign in again if the existing
login does not include the dedicated `git:tracker` consent. Discover the
configured Publisher remote, then restrict the helper to that repo:

```sh
fungi login --provider fungi --hub https://fungi.computer
fungi git-credential remote --hub https://fungi.computer --team TEAM_ID
git -c credential.helper= \
  -c 'credential.helper=!fungi git-credential --hub https://fungi.computer --team TEAM_ID' \
  -c credential.useHttpPath=true clone PUBLISHER_TRACKER_REMOTE
```

Use the same three `-c` settings for subsequent fetch and push commands.
Clearing the helper list prevents another configured credential helper from
storing the returned capability. This helper's `store` and `erase` operations
are silent; it keeps no Git credential cache. A capability lasts five minutes,
works only at Publisher for that tracker repository, and is never written to
disk or logs by `fungi`. Publisher retains the provider credential. Owner
revocation, membership removal and connected-client revocation stop subsequent
Git admission; settings and tracker consent remain owner-only.

## Update the installed local CLI

Run `fungi update` through the installed launcher. Fungi matches its real
installation against npm and pnpm's global roots or Bun's global bin directory,
as reported by those managers. It installs the registry's latest release with
the matching manager, verifies the installed CLI, then runs the new launcher's
public service stop/start functions. Unknown or ambiguous installations get a
manual reinstall command instead of a guessed manager.

An exclusive SQLite file lease covers installation, verification and restart. A
concurrent update is refused; process death releases the lease without PID
guessing or stale-lock deletion. A failed install/verification restores and
verifies the previous release without stopping its service. A restart failure
reports that the new version is installed and tells you how to reopen it.

## Contribute and license

From a repository checkout:

```sh
pnpm --filter @fungi.computer/spore typecheck
pnpm --filter @fungi.computer/spore lint
pnpm --filter @fungi.computer/spore test
```

The [development notes](docs/development.md) cover the source build, pane and
toast contracts, terminal display safety, packaging the npm candidate, the
upgrade rehearsals and developer source builds. See [`LICENSE`](LICENSE).
