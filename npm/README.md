# Shiitake

Spore (`@fungi.computer/spore`) installs Shiitake in your terminal or an ACP
editor such as Zed. Conversations and project tools use a local background
service; Fungi hosted models use the Team you choose at sign-in.

## Install

Install with Node 22.13 or newer and npm:

```sh
npm install -g @fungi.computer/spore
fungi --version
```

Shiitake needs Linux x64/arm64 with glibc 2.35+, or macOS 13.5+ on Apple Silicon
or Intel. Windows and Alpine/musl are not supported. The Node launcher reports
this requirement before loading native code on an unsupported machine. Keep npm
optional dependencies enabled: they supply the patch engine and pinned Bun
runtime. A separate Bun installation is not required.

On Apple Silicon, use arm64 Node. An x64 Node installation under Rosetta is
refused before loading the Intel runtime; switch Node architectures and
reinstall the CLI with optional dependencies enabled.

## Start in your project

```sh
fungi
```

On first run, choose **Use my Claude or ChatGPT subscription**. Finish the
provider's browser sign-in, then return to your terminal and send a prompt. You
can also choose an API key or Fungi models. A Fungi account is optional when you
use your own subscription.

To change your sign-in later, run `fungi login`. It opens the same
model-provider chooser. Use `fungi login --help` for direct provider options.
Login does not change an existing Session's model; use `/model` to choose one.

For hosted Fungi models, run `fungi login --provider fungi`, approve browser
sign-in and choose the Team that pays for models. Hosted models need Team
credit.

Hand your agent the
[local subscription recipe](https://docs.fungi.computer/agents/local-subscription.md)
for the install commands, checks and sign-in handoff.

## Connect Zed

Merge this entry into Zed's user settings:

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

Open the project in Zed and choose **fungi** from the Agent panel's new-thread
menu. Keep credentials out of editor settings. Use the editor's Stop control to
cancel work and history to reopen saved conversations. Closing an editor only
disconnects its client and can leave accepted work running.

The [editor guide](https://docs.fungi.computer/guides/use-fungi-in-your-editor/)
covers Neovim with Agentic.nvim, model selection for the same Session, generic
ACP clients and troubleshooting. `fungi acp --help` describes the stdio entry
point.

## Inspect, resume and stop

```sh
fungi status
fungi doctor
fungi sessions list
fungi resume
```

`fungi doctor` reports your platform, glibc version, saved Fungi sign-in, model
configuration and HTTP reachability without displaying credentials. On an
unsupported platform it reports the platform limit and leaves sign-in unchecked.
It does not send a model prompt, verify Team credit or check for updates.

Run these in the same project folder. `fungi stop` stops the shared service for
all local clients without deleting saved Sessions. After updating the CLI,
finish active work, stop the service, then reopen your editor's Agent.

See [Fungi documentation](https://docs.fungi.computer/) for account, billing and
support information. Third-party terms are preserved in `THIRD_PARTY_NOTICES`
and `native/apply-patch/LICENSE.codex`.
