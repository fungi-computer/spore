# Fungi terminal

`fungi` opens an Agent conversation in your project folder. Use it to give work,
inspect replies and tools, and resume saved Sessions. The browser's Shed App is
a shell on a Team Computer. This terminal is a conversation client for the Local
runtime.

## Install and start

The user install path is `@fungi.computer/cli`, with Node 22.13 or newer. This
private `@fungi.computer/tui` workspace supplies its terminal implementation. It
is not the package to install globally.

Install with npm, then sign in through your browser:

```sh
npm i -g @fungi.computer/cli
fungi login --provider fungi
fungi doctor
fungi
```

Run from your project folder. You can skip first-run setup. Fungi login opens
browser approval and selects the Team that pays for hosted models. With one
current Team, selection is automatic. Use `/model` to choose Fungi and a model
such as Luna. Login does not change an existing model selection.

Inside the terminal, `/model` chooses a model and `/thinking` selects a
supported level. **Use agent model** clears the Session override. Choices are
validated by Local without replacing the conversation. Fungi model use is
metered to the selected Team. Your own provider bills key/subscription work.
Local files, tools and Session storage stay on your machine in either case.

`fungi login` defaults to Fungi. Choose another provider explicitly with
`fungi login --provider <id>` or `/login` inside a conversation. A Fungi sign-in
refusal asks for another login, a credit refusal names the Team to fund, and a
paused or unreachable service requires retrying when available. Fungi failure
does not fall back to another model provider.

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
bindings. Escape dismisses a dialog or suggestions first. Otherwise, it
withdraws a waiting prompt or cancels active work. `/cancel` requests that
withdrawal or cancellation directly. Ctrl+C dismisses an open dialog first. With
a waiting prompt, it exits the client and leaves the prompt queued. During
active work, the first Ctrl+C requests cancellation. A second Ctrl+C exits even
while cancellation is pending. Ctrl+C also exits an idle client. `/exit` closes
the terminal client. `/reconnect` repairs history observation, not execution.
`/retry` resends the failed instruction. `/continue` asks for new continuation
work. Check partial changes before either action.

Closing the terminal leaves the shared local service running. `fungi stop` stops
it for every local client while retaining saved Sessions. The next launch starts
it again. Project data lives in `.fungi/`. Credentials live in the same user's
home configuration. Do not share credential files.

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

The default cell artwork is checked in at `src/tool-sigil-images.json`. After
changing the shared Sigils artwork or mapping, run
`node scripts/build-tool-sigils.mjs --update` from `apps/tui`; the unit suite
regenerates it to check freshness. Builds copy that input into the distribution.
Explicit `TUI_SIGIL_CELL_WIDTH`/`TUI_SIGIL_CELL_HEIGHT` build settings
regenerate pixels for custom cell geometry without changing the checked-in
default.

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
[account and logout recovery](../docs/src/content/docs/account/sign-in.mdx).

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

## Source setup and contracts

From a configured repository checkout:

```sh
pnpm turbo:run run build --filter=@fungi.computer/tui
pnpm --dir apps/tui run start --help
# Open the disposable design fixture in an interactive terminal.
pnpm --dir apps/tui run design:preview
```

The [CLI parser](src/cli.tsx) owns command grammar. The
[terminal application](src/terminal-application.ts) acquires the Local service
connection and renderer. [Pane shell](src/shell/workspace.tsx) reads one
registry. The [conversation pane](src/panes/conversation/index.tsx) presents
Parakeet's headless Session state through [Button](src/button/index.ts), the
TUI's interface kit and the only surface a pane may use.
[Terminal commands](src/panes/conversation/terminal-commands.ts) contribute
cancel, reconnect, retry and details actions. Exit belongs to the terminal.

Interactive `--connect` and `--listen`, and one-shot `--connect`, are rejected.
`fungi serve` is a separate foreground worker server. Client extensions use the
repeated `--extension` option. Their client interface supplies Session activity
and error reporting. Corral is included by default and reports activity and
pending questions to Herdr when the terminal supplies its pane and socket
environment. It has no effect outside Herdr and requires no change to Shiitake's
runtime core. Installed extensions are dynamically imported in the local process
and run with that process's OS access. Choose extensions you trust.

The client entry is closed `shiitake.client/v1` data shared with the browser
Chat renderer: chips, panel rows, timeline cells and activity. It does not
register panes. An App reaches the terminal through Gills (see
[App Gills](#app-gills)): admitted data that the built-in Gill pane renders,
with no App code in this process. Native pane kinds are trusted TUI source that
receives only Button.

Pending questions appear automatically in the expanding bottom footer without
moving focus or changing the draft. `Alt+↑` focuses the pending question;
`↑`/`↓` cycle when several are waiting, and `Enter` opens the ordinary answer
flow. `Esc` or `Alt+↓` returns to the draft. Answered or declined questions
disappear. `/answer` remains available.

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

Slash completion starts with available conversation commands. Stop appears while
work is active or waiting; retry and continue appear when their existing
recovery conditions apply. Settings remain reachable by their typed slash names.
Advanced commands, such as `/session`, appear only when their alias prefix is
typed. Pane controls and Row actions live in the command picker, not slash
completion.

A pane registers a kind in `src/panes/builtins.ts` and receives only `PaneKit`.
Its target parser and instance key belong to that kind. A kind that can open
without another pane's target declares a `launcher` (name, description and
target); **Open pane** (`Ctrl K o`) lists every declared launcher by name, the
built-in Local terminal first and then the programs an enabled extension
declares, and opens the chosen target through the registry, so a kind needs no
menu edit. New and resumed conversations and Apps follow them as host flows,
because Local supplies their targets. A pane that cannot open reports a notice;
the next key dismisses it, and no pane loses its keyboard. The registry
namespaces keys by kind, owns focus and input, and supplies Maosaico's cell
viewport. `PaneKit.setTitle()` changes only the pane’s sanitized display header,
never its identity or admission. Conversation targets may carry a display title;
without one, the header uses the Agent name and “New conversation”, never an id.
Commands, dialogs, status and theme presentation are leases: closing the pane or
retiring the workspace withdraws them. Narrow and zoomed panes stay mounted, so
drafts and history do not reset. The shared Agar window lifecycle disposes late
acquisitions; a failed replacement keeps the usable view. Loading and an empty
workspace use the same renderer. **Open pane → Local terminal** opens a shell on
your machine; see [Local terminal pane](#local-terminal-pane) for its access and
lifetime rules.

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

The Hub's `test:admitted-inbox-gill` includes the native `inbox-pane-round-trip`
proof at 80×24 and 160×48: real Local admission, published Grove backend,
filtered Inbox rows, visit and public hosted Session transport. It uses
disposable fixtures and does not establish a hosted deployment or real-model
qualification.

## Check this component

From the repository root:

```sh
pnpm --filter @fungi.computer/tui typecheck
pnpm --filter @fungi.computer/tui lint
pnpm --filter @fungi.computer/tui test
```

[CLI grammar](test/cli-grammar.test.ts),
[Session CLI](test/session-cli.test.mjs) and
[inspection](test/session-inspection.test.ts),
[registry lifetime](test/pane-registry-lifetime.test.tsx) and
[native pane lifetime](test/pane-shell-lifetime.test.tsx) tests cover the real
command contract. The [cold-build proof](scripts/cold-build.test.mjs) checks
clean package consumption. Native PTY, model-dialog, auth and packed-install
proofs are separate scripts in [package.json](package.json). Fixture replies do
not prove a live provider login or that the CLI is published on npm.

The [bundled ACP stdio proof](test/acp-stdio.proof.mjs) uses the maintained Node
launcher, an isolated home and project, a real persistent Local service and Faux
inference. After building the workspace and native patch engine:

```sh
pnpm --dir apps/tui bundle:cli
node apps/tui/scripts/bundle-native.mjs
# Linux x64 example; use cli-native-darwin-arm64 on Apple Silicon
# or cli-native-darwin-x64 on Intel Macs.
npm pack ./.botanical/fungi-cli-native-linux-x64 --pack-destination .botanical
npm install --prefix .botanical/fungi-cli-package --no-save --no-audit --no-fund ./.botanical/fungi.computer-cli-native-linux-x64-0.0.1.tgz
pnpm --dir apps/tui proof:acp
```

It checks initialization, new Sessions, workerd and native patch tools, exact
streaming, owner-confirmed cancellation, listing, history reload and retention
after disconnect. Installing the bundle's declared runtime dependencies does not
publish it. A real editor and model witness remains separate from this
deterministic transport proof.

## Prepare the public npm candidate

The bundler writes `@fungi.computer/cli` at inaugural version `0.0.1` under
`.botanical/fungi-cli-package`. Its explicit file list contains the launcher,
runtime bundles, [public README](npm/README.md) and third-party notices. One
common CLI tarball selects `@fungi.computer/cli-native-linux-x64`,
`@fungi.computer/cli-native-linux-arm64`,
`@fungi.computer/cli-native-darwin-arm64` or
`@fungi.computer/cli-native-darwin-x64` through npm optional dependencies. The
native packages carry their binary, platform metadata and notices. Node 22.13 or
newer is required. The Node launcher admits Linux x64/arm64 with glibc 2.35+ and
macOS 13.5+ on Apple Silicon or Intel. The common package has no npm OS/CPU
restriction so its diagnostic launcher can explain unsupported hosts; native
optional packages retain their platform constraints. `fungi doctor` reports
platform, glibc and saved sign-in status. Linux x64 builds use a digest-pinned
Ubuntu 22.04 container and Rust 1.98.1. Linux arm64 cross-builds use the same
Ubuntu baseline with its arm64 GCC and libraries. These cross-builds run on
Linux x64. Apple Silicon and Intel Mac cross-builds use a pinned cargo-zigbuild
image with its macOS SDK and Rust 1.98.1. The macOS candidate requires 13.5 or
newer because of workerd. The launcher checks Darwin 22.6 or newer and refuses
x64 Node on Apple Silicon; use arm64 Node there. Native engines use Cargo's
release profile with checkout and Cargo-cache paths remapped. Docker is required
for these container builds; installed users do not need Docker or Rust.

After building the workspace, build the native patch engine and bundle:

```sh
pnpm --dir runtimes/local build:native
node runtimes/local/scripts/build-apply-patch.mjs --target darwin-arm64
node runtimes/local/scripts/build-apply-patch.mjs --target darwin-x64
node runtimes/local/scripts/build-apply-patch.mjs --target linux-arm64
pnpm --dir apps/tui bundle:cli
node apps/tui/scripts/bundle-native.mjs linux-x64
node apps/tui/scripts/bundle-native.mjs darwin-arm64
node apps/tui/scripts/bundle-native.mjs darwin-x64
node apps/tui/scripts/bundle-native.mjs linux-arm64
npm pack --dry-run ./.botanical/fungi-cli-package
npm pack ./.botanical/fungi-cli-package ./.botanical/fungi-cli-native-linux-x64 ./.botanical/fungi-cli-native-darwin-arm64 ./.botanical/fungi-cli-native-darwin-x64 ./.botanical/fungi-cli-native-linux-arm64 --pack-destination .botanical
pnpm --dir apps/tui proof:cli ../../.botanical/fungi.computer-cli-0.0.1.tgz ../../.botanical/fungi.computer-cli-native-linux-x64-0.0.1.tgz
# Linux release qualification in the builder's actual glibc 2.35 userspace:
pnpm --dir apps/tui proof:linux-baseline ../../.botanical/fungi.computer-cli-0.0.1.tgz ../../.botanical/fungi.computer-cli-native-linux-x64-0.0.1.tgz
```

The bundlers' input graphs and Cargo's compiled-artifact messages supply the
third-party notice inventory. Native notice texts are cached beside their
binary, so packaging a restored build does not need the original Cargo checkout.
These build records stay outside the npm packages. Local unpublished proof
installs take the CLI tarball and matching native tarball together; ordinary
published installs resolve the native package through npm. The packed proof
installs with npm lifecycle scripts into a temporary home and checks metadata,
version, ACP help, a native file patch, Local service startup, one-shot output
and history presentation. It then runs the installed ACP client against the
workspace's persistent Local fixture with Faux inference, exercising a real
workerd-backed tool, the packaged native patch tool, streaming, cancellation and
history. It also rejects a missing native package. On Linux, `readelf` checks
every installed ELF dependency against the glibc 2.35 ceiling. The container
proof supplies `readelf` and runs those checks under glibc 2.35; running them on
a newer host alone does not qualify the older baseline. A real Hub login remains
a separate qualification. The CLI's own license is an open release decision;
third-party notices do not choose that license. Packaging does not authorize
publication. A cross-compiled Mach-O is build evidence only; repeat the packed
proof and the real Zed/Luna witness on Apple Silicon and Intel to qualify native
macOS execution. This candidate admits supported macOS hosts. Admitting it for
release before those native-machine witnesses is a separate Levi decision. The
Mach-O patch engine carries only the linker’s ad-hoc signature; it is not
developer-signed or notarized, and Levi’s signing decision remains open.

Linux arm64 likewise needs a native-machine packed proof and editor witness.
Pass its native tarball to `proof:cli` on that machine. An emulated patch-engine
smoke test establishes only that engine path, not native CLI/editor
qualification.

## Tracker Git

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

### Terminal display safety

Messages, Markdown, code, diffs, tool output and extension rows enter OpenTUI
through `terminalText`: the maintained `strip-ansi` parser removes terminal
programs, then a small filter drops remaining controls and bidi embeddings,
overrides and isolates. Word joiners and BOMs are removed because the native
renderer can use them to hide trailing cells. Newlines, tabs and Unicode shaping
characters remain; carriage returns become newlines. One-shot output is
sanitized only on a TTY; piped output stays byte-exact. The stored Session
content is unchanged.

A Markdown link shows `label — URL`: the full destination is ordinary text, so
mouse selection copies it even where a terminal or multiplexer drops OSC 8
hyperlinks. A link labelled with its own URL shows it once.

`pnpm --dir apps/tui proof:terminal-text` exercises the public CLI dispatcher
and real renderer on a disposable PTY with an isolated home and fixture Session;
it makes no model or login calls. To test an installed bundle, pass its
launcher: `pnpm --dir apps/tui proof:terminal-text -- /path/to/fungi`. The proof
resolves that launcher's sibling `cli.js` and calls its exported dispatcher
through the ordinary service dependency port. It does not replace the installed
files or connect to the shared Local service.

PTY panes must interpret output with a maintained VT emulator and render its
cell grid; they must never render raw PTY bytes as display text.

## Local terminal pane

Choose **Open pane → Local terminal** (`Ctrl K o`, then Enter) to run your login
shell in this CLI's working directory: `$SHELL`, else your account's passwd
shell, else `/bin/sh`, each only when it is an absolute path to an executable.
It starts as an interactive login shell, so your profile and rc files load. This
is a shell on your machine, with your user account's filesystem and OS access.
It is not a Team Computer or a sandbox. The launch implementation is qualified
on Linux with Bun 1.4.2, `setsid`, `ps` and `pkill`.

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
final grid and exit status visible. Like every footer, the pane's carries no key
hints. Programs that deliberately detach into another OS session remain ordinary
user-owned processes, outside that terminal session. If the TUI is killed with
SIGKILL (`kill -9`), cleanup cannot run and background jobs can be orphaned.
Human quit asks when a shell has child jobs, with **Keep shells running**
selected by default; **Quit and terminate** exits and cleans up the sessions. An
idle shell does not prompt. SIGTERM, SIGHUP and Team retirement still terminate
sessions without an interactive confirmation.

PTY output passes through `@xterm/headless`; only decoded cells reach OpenTUI.
Terminal title, clipboard and hyperlink programs do not run in the outer
terminal. The launch pane has no persisted process, scrollback or remote PTY
connection. Process output and keystrokes are not written to diagnostic logs.
Paste removes terminal programs and control characters before sending text to
the child, so pasted text cannot end bracketed paste early or send Ctrl-C.

## Update the installed local CLI

Run `fungi update /path/to/Botanical-next -C /path/to/project` through the
installed bundled launcher. The source checkout defaults to the current
directory; `-C` selects the project whose Saved Sessions must reopen. The
command requires Git, pnpm, npm, and the native build tools used by
`runtimes/local`.

Update fetches `origin/integration/parallel-work-tracking`, freezes that exact
commit, and builds its CLI in an isolated checkout under the source's ignored
`.botanical/` directory. It preserves the caller's branch and working changes.
Before activation it snapshots the project's Agent databases with SQLite,
including committed WAL data, into a private temporary project. A separate HOME
and service reopen the latest saved Session through the packaged `resume --last`
TUI and require its conversation composer to appear. Credentials are not copied.
The proof also checks Session counts and extension state versions. Missing
stores or a failed proof leave the installed launcher intact.

After proof, update stops the old Local service, atomically replaces the
existing PATH symlink with an immutable candidate, and checks that the new
service reopens the saved Session. An activation failure restores the exact
previous symlink and restarts the previous service. Run `fungi resume --last`
after a successful update to reopen the TUI. Build, proof, activation
diagnostics, and the previous link target are retained privately; an error
prints their path rather than raw process output.

The installed extension-version baseline lives in
`packages/shiitake-extensions/test/fixtures/installed-state-versions.json`.
Advance it when releasing higher state versions. A state version must never be
lowered during cleanup; the guard compares actual registered versions against
that baseline.
