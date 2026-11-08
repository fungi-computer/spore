# Spore development notes

These notes are for working on Spore in the Fungi repository. The
[README](../README.md) covers installing and using it.

## Source setup and contracts

Native command bindings use the installed OpenTUI parser's compact notation:
`<leader>x` means Ctrl-K, then x; `<leader>gx` means Ctrl-K, then g, then x.
Spaces in binding strings are literal Space keystrokes, not separators.
`<leader> g x` therefore requires two extra Space keystrokes. Display labels may
contain spaces; do not copy those labels back into binding declarations or add a
whitespace-normalizing compatibility parser.

From a configured repository checkout:

```sh
pnpm turbo:run run build --filter=@fungi.computer/spore
pnpm --dir apps/tui run start --help
# Open the disposable design fixture in an interactive terminal.
pnpm --dir apps/tui run design:preview
```

The [CLI parser](../src/cli.tsx) owns command grammar. The
[terminal application](../src/terminal-application.ts) acquires the Local
service connection and renderer. [Pane shell](../src/shell/workspace.tsx) reads
one registry. The [conversation pane](../src/panes/conversation/index.tsx)
presents Parakeet's headless Session state through
[Button](../src/button/index.ts), the TUI's interface kit and the only surface a
pane may use.
[Terminal commands](../src/panes/conversation/terminal-commands.ts) contribute
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
register panes. An App reaches the terminal through Gills (see App Gills (see
the README)): admitted data that the built-in Gill pane renders, with no App
code in this process. Native pane kinds are trusted TUI source that receives
only Button.

Pending questions appear automatically in the expanding bottom footer without
moving focus or changing the draft. `Alt+↑` focuses the pending question;
`↑`/`↓` cycle when several are waiting, and `Enter` opens the ordinary answer
flow. `Esc` or `Alt+↓` returns to the draft. Answered or declined questions
disappear. `/answer` remains available.

### Tool sigil artwork

The default cell artwork is checked in at `src/tool-sigil-images.json`. After
changing the shared Sigils artwork or mapping, run
`node scripts/build-tool-sigils.mjs --update` from `apps/tui`; the unit suite
regenerates it to check freshness. Builds copy that input into the distribution.
Explicit `TUI_SIGIL_CELL_WIDTH`/`TUI_SIGIL_CELL_HEIGHT` build settings
regenerate pixels for custom cell geometry without changing the checked-in
default.

## Toasts, attention and pane kinds

Transient information appears top-right, not in the footer. It expires after the
shared `toastDurationMs` (4 seconds), pauses while hovered where the terminal
reports pointer movement, and dismisses with `x`, a click or Esc. Esc dismisses
only the visible toast, without also closing a dialog or cancelling work.
Pending toasts show a count. Successful actions do not announce their own echo:
copy, collapse/expand, sign-in and successful recovery remain silent.

Inside `src/`, import `useToast` and `ToastInput` from `button/index.js`.
`useToast().show(input)` and `kit.toast(input)` share one owner. The input is
`{ variant, message, title?, duration?, action?, key? }`, with variants `info`,
`success`, `warning` and `error`. Duration is milliseconds or
`"until-dismissed"`; an action is
`{ label: string, run: () => void | Promise<void> }`. Return the operation's
Promise rather than detaching it: while pending, the card shows **Working…** and
cannot be activated or dismissed again. Completion advances the queue; a thrown
or rejected action becomes a persistent warning until acknowledged. For example:

```ts
toast.show({
  variant: "info",
  message: "Update ready",
  duration: "until-dismissed",
  action: { label: "Restart to update", run: restart },
});
```

Command failures, sign-in requirements and waiting questions remain attention
items until resolved or acknowledged. Pane-operation failures use
`duration: "until-dismissed"` to keep their toast available. Palette detection
silently falls back to terminal defaults; it is not an attention item.

The queue retains at most 20 individual pending cards. Transient chatter can
replace only another transient card, never unresolved attention. A producer can
give attention a stable `key` to update its one unresolved card instead of
queuing repeated failures. PaneKit scopes that identity to the pane;
acknowledging the card releases it. Terminal input and resize each have their
own identity.

If all individual slots contain attention, additional attention is recorded in
one bounded overflow record (count plus latest text), visibly flagged on the
current card. On dismissal it becomes a persistent **Attention capacity
reached** warning ahead of the individually retained cards. This explicitly says
that those additional reports could not be listed individually; it does not
pretend to retain every message or action.

A pane registers a kind in `src/panes/builtins.ts` and receives only `PaneKit`.
Its target parser and instance key belong to that kind. A kind that can open
without another pane's target declares a `launcher` (name, description and
target); **Open pane** (`Ctrl K o`) lists every declared launcher by name, the
built-in Local terminal first and then the programs an enabled extension
declares, and opens the chosen target through the registry, so a kind needs no
menu edit. New and resumed conversations and Apps follow them as host flows,
because Local supplies their targets. A pane that cannot open reports an
attention toast; dismiss it with `x`, a click or Esc. Ordinary typing does not
clear it, and no pane loses its keyboard. The registry namespaces keys by kind,
owns focus and input, and supplies Maosaico's cell viewport.
`PaneKit.setTitle()` changes only the pane’s sanitized display header, never its
identity or admission. Conversation targets may carry a display title; without
one, the header uses the Agent name and “New conversation”, never an id.
Commands, dialogs, status and theme presentation are leases: closing the pane or
retiring the workspace withdraws them. Narrow and zoomed panes stay mounted, so
drafts and history do not reset. The shared Agar window lifecycle disposes late
acquisitions; a failed replacement keeps the usable view. Loading and an empty
workspace use the same renderer. **Open pane → Local terminal** opens a shell on
your machine; see the Local terminal pane for its access and lifetime rules.

## Gill proof

The Hub's `test:admitted-inbox-gill` includes the native `inbox-pane-round-trip`
proof at 80×24 and 160×48: real Local admission, published Grove backend,
filtered Inbox rows, visit and public hosted Session transport. It uses
disposable fixtures and does not establish a hosted deployment or real-model
qualification.

## Checks and proofs

[CLI grammar](../test/cli-grammar.test.ts),
[Session CLI](../test/session-cli.test.mjs) and
[inspection](../test/session-inspection.test.ts),
[registry lifetime](../test/pane-registry-lifetime.test.tsx) and
[native pane lifetime](../test/pane-shell-lifetime.test.tsx) tests cover the
real command contract. The [cold-build proof](../scripts/cold-build.test.mjs)
checks clean package consumption. Native PTY, model-dialog, auth and
packed-install proofs are separate scripts in [package.json](../package.json).
Fixture replies do not prove a live provider login or that the CLI is published
on npm.

The [bundled ACP stdio proof](../test/acp-stdio.proof.mjs) uses the maintained
Node launcher, an isolated home and project, a real persistent Local service and
Faux inference. After building the workspace and native patch engine:

```sh
pnpm --dir apps/tui bundle:cli
node apps/tui/scripts/bundle-native.mjs
# Linux x64 example; use spore-native-darwin-arm64 on Apple Silicon
# or spore-native-darwin-x64 on Intel Macs.
npm pack ./.botanical/fungi-cli-native-linux-x64 --pack-destination .botanical
npm install --prefix .botanical/fungi-cli-package --no-save --no-audit --no-fund ./.botanical/fungi.computer-spore-native-linux-x64-0.0.1.tgz
pnpm --dir apps/tui proof:acp
```

It checks initialization, new Sessions, workerd and native patch tools, exact
streaming, owner-confirmed cancellation, listing, history reload and retention
after disconnect. Installing the bundle's declared runtime dependencies does not
publish it. A real editor and model witness remains separate from this
deterministic transport proof.

## Prepare the public npm candidate

The bundler writes `@fungi.computer/spore` at inaugural version `0.0.1` under
`.botanical/fungi-cli-package`. Its explicit file list contains the launcher,
runtime bundles, [public README](../npm/README.md) and third-party notices. One
common CLI tarball selects `@fungi.computer/spore-native-linux-x64`,
`@fungi.computer/spore-native-linux-arm64`,
`@fungi.computer/spore-native-darwin-arm64` or
`@fungi.computer/spore-native-darwin-x64` through npm optional dependencies. The
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
pnpm --filter @fungi.computer/truffle build:native
for target in darwin-arm64 darwin-x64 linux-arm64; do
  node packages/cordyceps/native/apply-patch/build.mjs --target "$target" --out ".botanical/native-build/$target/bin"
done
pnpm --dir apps/tui bundle:cli
node apps/tui/scripts/bundle-native.mjs linux-x64
node apps/tui/scripts/bundle-native.mjs darwin-arm64
node apps/tui/scripts/bundle-native.mjs darwin-x64
node apps/tui/scripts/bundle-native.mjs linux-arm64
npm pack --dry-run ./.botanical/fungi-cli-package
npm pack ./.botanical/fungi-cli-package ./.botanical/fungi-cli-native-linux-x64 ./.botanical/fungi-cli-native-darwin-arm64 ./.botanical/fungi-cli-native-darwin-x64 ./.botanical/fungi-cli-native-linux-arm64 --pack-destination .botanical
pnpm --dir apps/tui proof:cli ../../.botanical/fungi.computer-spore-0.0.1.tgz ../../.botanical/fungi.computer-spore-native-linux-x64-0.0.1.tgz
# Linux release qualification in the builder's actual glibc 2.35 userspace:
pnpm --dir apps/tui proof:linux-baseline ../../.botanical/fungi.computer-spore-0.0.1.tgz ../../.botanical/fungi.computer-spore-native-linux-x64-0.0.1.tgz
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

## Terminal display safety

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

## Local terminal pane internals

On Linux PTY output passes through `@xterm/headless`; only decoded cells reach
OpenTUI. On macOS raw PTY output goes to the native OpenTUI terminal, while
Ghostty inside the PTY daemon answers terminal queries. The pane sends native
input and paste to the PTY but does not send OpenTUI's duplicate query
responses. Terminal title, clipboard and hyperlink programs do not run in the
outer terminal. The launch pane has no persisted process, scrollback or remote
PTY connection. Closing it shuts down the daemon rather than detaching or
handing it off. Process output and keystrokes are not written to diagnostic
logs. Linux paste uses `terminalText`; macOS uses OpenTUI's native paste
encoder. Both remove terminal programs and control characters before sending
text to the child, so pasted text cannot end bracketed paste early or send
Ctrl-C. An input larger than the Mac PTY's bounded pending capacity is refused
with an attention toast; it does not silently terminate a healthy program.

The Mac-native check in `test/local-mac-pty.test.ts` exercises controlling
`/dev/tty`, display, paste, resize, a background job, close and queued-input
teardown. `test/fairy-ring-program-mac.test.tsx` installs a frozen extension
fixture and opens its real launcher through **Open pane**, with only the
underlying `fairy-ring` executable replaced by a synthetic shell. Given an exact
frozen Rust binary and matching extension source, it runs the same install →
Open → PaneKit path against the actual read-only dashboard, a synthetic Claude
sign-in file and a rejecting/shadowed `fungi account --json` executable:

```sh
FAIRY_RING_BIN=/path/to/fairy-ring \
  FAIRY_RING_EXTENSION=/path/to/fungi-extension \
  pnpm --dir apps/tui run test:unit -- ./test/fairy-ring-program-mac.test.tsx
```

The joined proof creates its own HOME, file-only synthetic account and shadow
`fungi` executable; it neither reads live accounts nor installs a program.

## Update notifications

The notification watcher is prepared behind
`watchFungiUpdates(notify: (notice: UpdateNotification) => void): () => void`.
It emits `{ kind: "available", version }` or `{ kind: "restart", version }`,
once per version and kind for that watcher lifetime. The returned function
cancels the timer and in-flight registry check. Checks are nonblocking, run
immediately and every ten minutes, and use a three-second registry deadline. Set
`"update": "off"` in `~/.config/fungi/tui.json` to disable checks; `"notify"` is
the default. Failures go to the bounded diagnostic log.

`UpdateToasts` adapts those facts to the shared toast API: an `info` toast with
`Fungi <version> is available: run fungi update` uses the shared default
duration; `Update installed: restart to update` remains until dismissed and
offers **Restart to update**, invoking the supplied restart callback. The
adapter has no renderer, queue, or duration timer of its own.

**Lifecycle integration is pending.** The adapter is not mounted in the terminal
yet: its restart callback must use the incoming lifecycle owner's
version-checked ensure path. The standalone update overlay remains deleted.
Release clients do not automatically replace the running terminal.

## Published-updater rehearsals

After building and packing the candidate, select published **Fungi releases**.
`--from` is required and repeatable; candidate directory and report are
required:

```sh
pnpm proof:upgrade-rehearsal --from 0.6.0 --from 0.5.0 --candidate /absolute/pack-npm-dir --report /absolute/fresh-report.json
```

The rulebook's sole `releasePackages(fungiVersion)` walks main's first-parent
history, matches the version JSON, reads that commit's exact Spore and Oyster
versions, and decodes both `npm view --json` integrities with Zod. Zero or
multiple matching commits are refused; releases before Fungi 0.4.0 have no
version JSON and are unsupported. No version is inferred from commit subjects.
Fungi 0.6.0 ships Spore 0.5.0; those version lines are not interchangeable.

The candidate is the existing `pack-npm` directory with verified `order.tsv` and
`SHA256SUMS`: no loose tarballs, fallback pack or implicit baseline. The fresh
JSON report is decoded with the exported `upgradeReportSchema` in
`test/upgrade-report.mjs`. Its `from[]` records Fungi, Spore, Oyster and both
integrities; `checks[]` records name, Fungi baseline and pass/fail. Failed or
empty checks fail the command. S3's populated/named-check extension and Z1's
runner consume this same interface.

Each run installs the resolved Spore baseline into its own HOME and global
prefix, creates and reads a Session, runs the actual published `fungi update`,
then checks the candidate service's live build identity and reads that same
Session by its original ID in the same project. It copies no model credentials
and does not claim a completed model turn. This proves the Local service/Session
transition, **not an Oyster host, populated registry, App-data or Home
upgrade**.

The rehearsal supplies an isolated npm registry transport for the unpublished
local archives, including a command-local CA for the published updater's
registry lookup. It does not replace the update algorithm or publish anything.
Use a distinct candidate package version, such as `0.7.0-candidate.<shortsha>`,
stamped only into disposable pack artifacts; equal baseline/candidate versions
prove only a no-op. Proof homes and JSON receipts remain under ignored
`.botanical/upgrade-proof/`.

## Developer source builds

Run `fungi update --from-source /path/to/Botanical-next -C /path/to/project`
through the installed bundled launcher. `-C` selects the project whose Saved
Sessions must reopen. The command requires Git, pnpm, npm, and the native build
tools used by `runtimes/local`.

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
