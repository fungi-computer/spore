# @fungi.computer/spore

## 0.4.0

### Minor Changes

- Changes since 0.3.1:

  - fix(shiitake-extensions): shorten the loop start prompt title to fit the
    60-character contract
  - fix(whistle,tui): cap prompt titles at 60 in the contract; waiting cancel is
    not timed out
  - fix(upgrade): preserve prior identity and tolerate refused home reads
  - feat(cli): upgrade home before dispatch and join names-only notices
  - feat(cli): recommend own subscription on first run
  - feat(release): derive upgrade news from checked changelog
  - fix(tui): keep full Git push warning visible on confirmation
  - fix(tui): footer stop loop asks first; modal rules walk the real producers
  - fix(release): inline Gitleaks fixture allows
  - fix(tui): size pane modals in the Button, not the panes
  - fix(tui): open details while typing, and say Esc close on text prompts
  - fix(approvals): bound confirmation and refuse invalid noted approvals
  - fix(goal): let an Agent settle and resume its own paused goal
  - feat(tui): migrate the Loop, extension, Archive, Skills, question and
    recovery modals
  - fix(parakeet): no current marker on the sign-in provider list
  - feat(tui): migrate the model, sign-in, resume, fork and Home pickers to the
    shared modal
  - feat(tui): shared modal anatomy with safe-first confirmations and Goal
    paused
  - fix(approval): type the native denial expectation
  - feat(approval): carry bounded denial feedback and optional rule coverage
  - fix(spore): keep escape risk visible with safe approval choices
  - fix(cli): clarify provider-specific sign-in guidance
  - feat(approval): make one-time approval the safe default
  - fix(tui): approve MCP escapes once by default
  - fix(cli): prioritize BYOK in missing-model guidance
  - fix(tui): compose approval card on modal-c Integration

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.4.0
  - @fungi.computer/approvals@0.2.0
  - @fungi.computer/parakeet@0.4.0
  - @fungi.computer/shiitake-extensions@0.3.0
  - @fungi.computer/shiitake@0.5.0
  - @fungi.computer/veil@0.2.1
  - @fungi.computer/whistle@0.2.0
  - @fungi.computer/nacre@0.0.3
  - @fungi.computer/corral@0.1.3

## 0.3.1

### Patch Changes

- Changes since 0.3.0:

  - fix(spore): keep escape risk visible with safe approval choices
  - fix(cli): clarify provider-specific sign-in guidance
  - fix(cli): prioritize BYOK in missing-model guidance
  - fix(tui): approve MCP escapes once by default

## 0.3.0

### Minor Changes

- Changes since 0.2.1:

  - fix(local): receive Spore release version from CLI owner
  - fix(local): explain native package startup refusal
  - fix(local): fall back when no session bus address exists
  - feat(local): keep Oyster MCP keys in OS keychain
  - fix(local): render host Git hook warning without duplicated grant label
  - fix(local): disclose diff hook risk without repeating card label
  - fix(local): fence grants to protected Git remote names
  - fix(local): disclose Git hook execution on grant cards
  - fix(local): refuse read-only Files edits without approval
  - fix(local): fence Git grants to protected repositories and safe argv
  - fix(local): verify and stage native payload once per owner
  - fix(tui): stabilize cold-build cache input
  - fix(local): ship both Linux permission filters in native CLI
  - fix(local): narrow project rules and audit matched commands
  - fix(live-updates): consume activity frames across clients
  - fix(shiitake): await exact command settlement without session watches
  - fix(local): tighten permission approval edge cases
  - fix(spore): show bounded Files approvals and explicit git grant risk
  - feat(local): remember human-approved exec prefixes
  - fix: isolate provider prose to recorded failed turns
  - fix: retain provider error text on failed turns
  - feat(local): dispatch approved sandbox escapes once through ledger handoff
  - feat(local): make workspace Git metadata read-only
  - fix: admit Local permission modes before persisting Agents
  - feat: enforce local agent permission modes across service and tests
  - feat: introduce local agent permission modes
  - fix(spore): stop Bun loading Agent project config into host
  - fix(shiitake): merge integration permission callers into settlement waits

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/approvals@0.1.0
  - @fungi.computer/parakeet@0.3.0
  - @fungi.computer/shiitake-extensions@0.2.0
  - @fungi.computer/shiitake@0.4.0
  - @fungi.computer/agar@0.3.1
  - @fungi.computer/corral@0.1.2
  - @fungi.computer/nacre@0.0.2

## 0.2.1

### Patch Changes

- Changes since 0.2.0:

  - fix(spore): stop Bun loading Agent project config into host
  - fix(spore): order native digests and bound sandbox staging
  - fix(spore): anchor native payloads to built JS and stage verified bytes
  - fix(tui): dispose embedded goal proof service
  - fix(mule): migrate remaining Spore and Demo model consumers

- Updated dependencies
- Updated dependencies
  - @fungi.computer/shiitake-extensions@0.1.1
  - @fungi.computer/shiitake@0.3.1
  - @fungi.computer/parakeet@0.2.1
  - @fungi.computer/corral@0.1.1

## 0.2.0

### Minor Changes

- Changes since 0.1.1:

  - fix(acp): retain UI attachments for connection lifetime
  - test(spore): relocate packed proof installs and retain evidence
  - test(tui): restore HOME when terminal service stop rejects
  - fix(tui): bundle production React in the shipped CLI
  - fix(docs): repair Oyster setup and name terminal entry points
  - fix(parakeet): retire unanswered advertised prompts with their intents
  - fix(local): protect resolved sandbox paths and every Git directory
  - test(spore): satisfy async act fixture lint
  - test(spore): cover default offline Fungi logout
  - test(tui): settle remaining unit interaction and frame owners
  - test(tui): preserve raw key timing in a production-root proof
  - test(tui): join CLI query delivery and pane fixture lifetimes
  - test(tui): checkpoint awaited unit renderer lifetimes
  - refactor(spore): validate command grammar with typed schemas
  - test(tui): cover stale sandbox status replies
  - test(spore): characterize existing command validation
  - test: repair B4 sandbox and TUI qualification fixtures
  - test(tui): join recovery notifications before native frame waits
  - test(tui): settle native recovery work inside act
  - test(tui): preserve native binding teardown before act flush
  - test(tui): settle native frame updates within React act
  - test(tui): await owner recall before checking native frame
  - feat(mule,shiitake,parakeet)!: separate tool data from model values
  - test(local): repair isolated service recovery fixtures
  - test(tui): clarify manual approval fixture and Bun assertions
  - test(tui): cover live approval membership revocation
  - test(tui): expose installed service recovery queue failure
  - test(tui): wait for idle before asserting native Ctrl+C exit
  - test(tui): await focused native command readiness before exit
  - test(tui): use the explicit Node output boundary in React proof
  - fix(tui): deploy native frame proofs with one React runtime
  - test(tui): align sandbox store and picker readiness fixtures
  - feat(tui): compose canonical approval renderer on current contract
  - test(tui): migrate sandbox status connection producers
  - fix(tui): qualify current fixtures and simplify independent consumers
  - feat(tui): isolate independent leader and Grove bundle
  - test(tui): wait for question interaction dismissal
  - test(tui): use incomplete code for source-preservation diagnostics
  - feat(local): connect project MCP with private Oyster keys
  - fix(tui): await conversation admission before probing frames
  - test(tui): reproduce CLI admission outliving frame passes
  - test(tui): follow command host to Nacre after shell split
  - fix(local): retain config root in app panes and serve
  - fix(local): pin host configuration through runtime and tui
  - feat(tui): place chosen panes beside or below the focused pane
  - feat(tui): bind main resize and reset owner preference
  - feat(tui)!: replace split commands with named layouts
  - fix(whistle): reuse normal rows after command retry
  - feat(shiitake): expose unknown request outcomes and fleet receipts
  - feat(maosaico)!: replace tiling axis with named layouts
  - fix(extensions): isolate required state resets from session runs
  - fix(whistle): discard secret answers between attempts
  - fix(goal): pin cleared events to committed session positions
  - test(tui): use explicit void callback bodies
  - feat(tui): use fzf matching and grapheme-safe highlights
  - fix(whistle): retry the failed interaction operation
  - build(tui): repair fzf NodeNext declaration imports
  - refactor(files): split search tools and align hosted ignore visibility
  - refactor(mule): require typed retry contracts across model owners
  - test(tui): await native cancellation stream notifications
  - fix(tui): remove queued-message recall hint
  - test: move CLI service logging proof into TUI ownership
  - test(spore): await streaming Query notification before native Escape
  - test: align service diagnostics fixtures with the public contract
  - fix(truffle): use unpatched Pi and person-only ChatGPT identity
  - fix(goal): type pause causes and restrict human attention
  - fix(subagents): start the conversation footer collapsed
  - refactor(oyster)!: move the shell client into @fungi.computer/nacre
  - fix(truffle): keep doctor tests on the public status contract
  - fix(tui): seed the conversation footer record the Local host reads
  - fix(local): stale clients never stop the installed service; bound drain
  - test(spore): migrate lifecycle status fixtures to protocol 2
  - test(spore): await rendered picker output
  - test(spore): await observable command and session readiness
  - chore(local): checkpoint unqualified service logging draft
  - fix(spore): rebind while an installed update waits for a turn
  - fix(parakeet): close joined admission and visitor contracts
  - fix(spore): consume recovery surface through public Button API
  - test(spore): satisfy recovery fixture lint contracts
  - test(spore): await complete recovery and type unused commands
  - test(spore): await actual recovery controller transitions
  - fix(spore): retain outage recovery until a fresh session snapshot
  - fix(tui): preserve native typing between recall key events
  - fix(recall): qualify native payloads and Grove composer recovery
  - fix(spore): reconcile public checkpoint and frame lifecycle
  - chore(recall): preserve adapter and proof work for update custody
  - fix(spore): expose updater types and track runtime preload
  - test(tui): require live replacement observation in update proof
  - test(tui): prove isolated installed update draft continuity
  - feat(tui): mount the public composer checkpoint bridge
  - fix(stop-all): use public Button parser and result contract
  - fix(spore): bind composer recovery to durable Agent and Session
  - feat(tui): gate explicit update restart on public draft checkpoints
  - fix(tui): use public Button toast contract in terminal controls
  - test(tui): prove restart entry uses a fresh public ensure owner
  - fix(tui): mount update notices and use new-launcher lifecycle ensure
  - test(stop-all): qualify final toast pressure and bounded cancellation
  - test(tui): observe action rejections without dropping errors
  - fix(tui): protect toast attention and action lifecycle
  - test(extensions): bound fixture skill discovery to its synthetic project
  - fix(recall): preserve authorization errors across Session transport
  - test(spore): await model observer notifications in footer proof
  - test(tui): align picker callers and capture populated flows
  - test(spore): dispatch numeric picker keys synchronously
  - test(spore): guard picker navigation and out-of-range digits
  - fix(tui): clear picker commands and expose local management
  - test(tui): move notice consumers to current toast contract
  - test(toasts): remove obsolete success-dialog expectations
  - test(tui): make service restart proof portable and load-independent
  - test(spore): stop in-process login listener without killing runner
  - fix(tui): finish toast dismissal and attention lifecycles
  - test(stop-all): await the settled footer observation and record gates
  - test(spore): remove obsolete receipt dismissal from caller flows
  - test(spore): use the lint-valid prompt readiness type
  - test(spore): await the real login prompt before rendering
  - refactor(spore): remove unused toast facade type aliases
  - fix(stop-all): toast rejected requests and await running cancellation
  - test(spore): use the lint-valid prompt readiness type
  - test(spore): await the real login prompt before rendering
  - feat(truffle): add atomic subscription credential activation
  - test(spore): cover one-action account switch completion
  - fix(parakeet): send composer drafts optimistically across clients
  - fix(spore): commit single choices without a second confirmation
  - chore(oyster): wip extraction pending host adapter corrections
  - fix(tui): stop incompatible recovery and bound rebind attempts
  - feat(spore): show one stop-all summary through pane toasts
  - feat(spore): adapt update facts to the shared toast API
  - feat(spore): wire composer stop-all to the Local service
  - feat(shiitake): carry process-local tool output snapshots
  - feat(tui): one toast owner; footer keeps only attention items
  - feat(truffle): stop made-by Agent trees without retiring chats
  - refactor(spore): prepare update facts for shared toast integration
  - fix(reload): verify live snapshots and release removed timers
  - test(spore): wait for the restart message, not a timer
  - test(tui): give the session-cli connection fixture a rebind and drop the
    banner race
  - fix(truffle): signal only the process service.json names
  - fix(truffle): never let fungi stop signal its own process
  - fix(spore): retain install deadlines and simplify update checks
  - test(spore): stop the in-process login fixture without killing the runner
  - test(spore): prove a fungi start replaces a stale service
  - fix(reload): name the existing stop command in restart refusal
  - chore: checkpoint fungi reload WIP, not ready
  - fix(goal): a restart resumes the goal; a stopped turn always pauses it
  - test(spore): checkpoint restart failure coverage, not ready
  - feat(tui): show a restart overlay and rebind the Session when the service
    returns
  - test(spore): wip CLI e2e for stale-service replacement, not ready
  - feat(spore): checkpoint fungi updates and notices, not ready
  - test(goal): bring the goal proofs to the current model and footer
  - feat(truffle): version-checked ensure for every client start
  - fix(goal): only a live or paused goal is current
  - fix(subagents): footer and drawer rows no longer say who made the Agent
  - fix(truffle): bound fungi stop with SIGTERM, then SIGKILL after 5 s
  - test(tui): answer the account status call and await it before the login
    picker
  - fix(truffle): make the blank-key refusal fixed by type and prove it end to
    end
  - fix(truffle): show a refused blank API key as plain No key entered in /login
  - feat(shiitake): drop an insufficient background summary before appending
  - fix(tui): make Esc during sign-in a calm cancel
  - fix(shiitake): label stale notices and type usage as stale-only
  - feat(shiitake): add compaction head check and stale notice
  - feat(shiitake): store compactions as head, model and data, and rewrite old
    rows
  - fix(agents): current-schema footer fixture, register archive operations'
    replay class
  - fix(agents): landing archive abort is an explicit branch, not a silent catch
  - test(tui): the real-store row test asserts its log and ends its run instead
    of swallowing errors
  - feat(tui): collapse another Agent's message behind the agent Sigil
  - fix(subagents): token-shaped keys log as *; test a collapsed footer with a
    waiting child
  - fix(agents): serialize archive with admission, refuse pending work and old
    stores
  - feat(subagents): /agents collapses and expands the footer rows; failure log
    names its cause
  - feat(agents): archive agents; an agent tidies the ones it made, a person any
  - feat(shiitake): run on pi-ai 1.3.0
  - fix(local): shrink each image in a throwaway worker so its memory returns
  - test(spore): take integration's cold-build test
  - fix(local): show an old-schema store in the landing picker as unreadable
  - feat(files): one find tool replaces list, glob and grep
  - feat(extensions): installed extensions can bring skills
  - fix(tui): one provider/model (level) formatter for the footer and the
    landing
  - test(tui): derive the cold-build package name from package.json
  - fix(local): review fixes for the Agent picker
  - fix(local): /model sets the Agent's default; one startup-model resolver for
    sessions and the landing
  - test(tui): discovery fixtures list their Agents
  - fix(local): pick the Agent when a folder has several, and say why select
    fails
  - fix(tui): read message authors through the Button kit
  - feat(session): show another Agent's message as a compact block
  - fix(tui): thread the question extension id from the CLI entry
  - fix(tui): show the thinking level as (level) so narrow footers keep the
    model
  - fix: remove Shiitake dogfood friction in execute, exec, apply_patch and the
    TUI footer
  - fix(corral): only question headers reach herdr; blocked survives command
    work
  - feat(corral): herdr shows an open agent question as blocked
  - feat(session): show goal and loop automation in the footer, not the timeline
  - test(tui): follow the Open pane order with New conversation first
  - fix(tui): start workspace-level New conversation from a live pane's Agent
  - fix(tui): open New conversation from the Open pane picker after the first
    pane closes
  - test(spore): read the expected --version from package.json
  - test(spore): expect fungi 0.1.1 from --version after the 0.2.0 release bump
  - feat(oyster): public release 0.2.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.3.0
  - @fungi.computer/approvals@0.0.2
  - @fungi.computer/cairn@0.1.0
  - @fungi.computer/corral@0.1.0
  - @fungi.computer/gills@0.2.0
  - @fungi.computer/lantern@0.3.0
  - @fungi.computer/maosaico@0.1.0
  - @fungi.computer/nacre@0.0.1
  - @fungi.computer/parakeet@0.2.0
  - @fungi.computer/shiitake-extensions@0.1.0
  - @fungi.computer/shiitake@0.3.0
  - @fungi.computer/stipe@0.1.0
  - @fungi.computer/veil@0.2.0
  - @fungi.computer/whistle@0.1.0

## 0.1.1

### Patch Changes

- Initial public release of @fungi.computer/spore.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.2.0
  - @fungi.computer/corral@0.0.1
  - @fungi.computer/gills@0.1.0
  - @fungi.computer/lantern@0.2.0
  - @fungi.computer/oyster@0.2.0
  - @fungi.computer/parakeet@0.1.0
  - @fungi.computer/shiitake@0.2.0
  - @fungi.computer/veil@0.1.0
  - @fungi.computer/whistle@0.0.2
  - @fungi.computer/shiitake-extensions@0.0.2
