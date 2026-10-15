# Audited TUI proof dispositions

The nightly gate runs `test:nightly` after the ordinary package build. Each
retained proof runs in its own Bun process, keeping mocks and renderer state
isolated. These terminal renderers do not belong in the batch gate.

| Audited file                                | Disposition and reason                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `copy-focus-headed.proof.mjs`               | Delete: interactive capture has no assertions or automatic exit; `copy-focus.test.tsx` exercises mouse selection and clipboard behavior.                                                                                       |
| `design-native.proof.mjs`                   | Nightly: native mixed-content renderer assertions supplement the unit fixtures.                                                                                                                                                |
| `dialog-design.proof.tsx`                   | Nightly: native command/completion/account dialog assertions need the terminal renderer.                                                                                                                                       |
| `files-edit-error-native.proof.mjs`         | Nightly: built TUI renders the typed file-edit refusal without leaking internal errors.                                                                                                                                        |
| `interactive-smoke.proof.mjs`               | Pre-install and TUI-change check (`proof:interactive`): real launcher in a real PTY, signed out and signed in; types `/`, opens and types into a terminal pane, walks every Open pane choice, closes back to the conversation. |
| `memory-repro.proof.mjs`                    | Nightly: long transcript growth and cleanup assertions qualify renderer resource behavior.                                                                                                                                     |
| `patch-mismatch-native.proof.mjs`           | Nightly: built TUI renders the failing hunk and its relevant source lines.                                                                                                                                                     |
| `private-local-shiitake-host.bun-proof.mjs` | Delete: mocks removed `codex-models.js`/`createPrivateCodexModels`; current Local host/model/worker tests exercise the maintained `local-models` owner and service transport.                                                  |
