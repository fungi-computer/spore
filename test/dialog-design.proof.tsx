import { fixtureClients } from "./fixture.js";
// Capture the terminal's dialog surfaces (commands, completion, account) for
// design review. Run: DESIGN_CAPTURE_DIR=<dir> bun test/dialog-design.proof.tsx
// Login runs the real account contribution over Local's policy-filtered Pi
// registry; only the provider sign-in itself is scripted.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { setTimeout as wait } from "node:timers/promises";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { createPrivateModels } from "@fungi.computer/truffle";
import {
  localLoginProviders,
  localPopularProviderIds,
} from "@fungi.computer/truffle/login";
import {
  contributeAccountCommands,
  type AccountOwner,
  type ProviderAccess,
} from "@fungi.computer/parakeet/headless";
import { loginAllowed } from "@fungi.computer/veil/model-credentials";
import { TuiFrame } from "../src/frame.js";
import {
  createDesignTuiFixture,
  representativeDesignSnapshot,
  longHistoryDesignSnapshot,
} from "./design-fixture.js";
import { idleActivity } from "@fungi.computer/parakeet-testing";
import type { SessionSnapshot } from "@fungi.computer/shiitake/client";
import { createTuiFixture, type TuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";
import {
  createWhistleInteractionHost,
  type WhistleInteractionHost,
} from "@fungi.computer/whistle/interaction";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

function GroupedPicker({ host }: Readonly<{ host: WhistleInteractionHost }>) {
  const { colors } = useTerminalTheme("mocha");
  return (
    <DialogSurface
      colors={colors}
      onClose={() => {
        host.cancel();
      }}
    >
      <InteractionView
        host={host}
        colors={colors}
        onClose={() => {
          host.cancel();
        }}
      />
    </DialogSurface>
  );
}

const output = process.env.DESIGN_CAPTURE_DIR;
if (output) await mkdir(output, { recursive: true });

type Setup = Awaited<ReturnType<typeof testRender>>;
type Size = Readonly<{ width: number; height: number }>;

const modelSource = {
  identity: "design-models",
  effectiveModel: () =>
    Promise.resolve({
      agentName: "Shiitake" as const,
      providerId: "fungi",
      providerName: "Fungi",
      modelId: "@fungi/luna",
      modelName: "Luna",
      credential: { kind: "missing" as const, source: "Sign in required" },
      label: "Sign in to Fungi",
    }),
  models: () =>
    Promise.resolve(
      [
        ["anthropic", "Anthropic", "claude-sonnet-5", "Claude Sonnet 5"],
        ["fungi", "Fungi", "@fungi/luna", "Luna"],
        ["openai", "OpenAI", "gpt-6-sol", "GPT-6 Sol"],
        ["openrouter", "OpenRouter", "qwen-4-coder", "Qwen 4 Coder"],
      ].map(([providerId, providerName, id, name]) => ({
        providerId: providerId ?? "",
        providerName: providerName ?? "",
        id: id ?? "",
        name: name ?? "",
        reasoning: ["low", "medium", "high"] as const,
      })),
    ),
  modelPreference: {
    read: () => Promise.resolve(null),
    set: () => Promise.resolve(),
  },
};

const registry = localLoginProviders(createPrivateModels().getProviders());
const never = new Promise<never>(() => undefined);

/** A Local owner whose provider sign-in is scripted per scene. */
function scriptedOwner(
  login: AccountOwner["login"] = () => never,
  access: readonly ProviderAccess[] = [],
): AccountOwner {
  return {
    popularProviderIds: localPopularProviderIds,
    access: () => Promise.resolve(access),
    providers: () => Promise.resolve(registry),
    login,
    logout: () => Promise.resolve(),
    status: () => Promise.resolve("OpenAI: configured (oauth)"),
  };
}

async function scene(
  name: string,
  size: Size,
  owner: AccountOwner,
  drive: (setup: Setup, fixture: TuiFixture) => Promise<void>,
  fixture: TuiFixture = createDesignTuiFixture(),
) {
  console.log(
    `Dialog scene: ${name} ${String(size.width)}x${String(size.height)}`,
  );
  const commands = createWhistle();
  contributeAccountCommands(commands, owner, {
    sourceId: "design",
    namespace: "account",
    host: "local",
    scope: "user",
    policy: { loginAllowed },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        clients={fixtureClients}
        commands={commands}
        initialTheme="mocha"
        session={fixture.session}
        modelSource={{
          ...modelSource,
          account: {
            owner,
            host: "local",
            scope: "user",
            policy: { loginAllowed },
          },
        }}
        onExit={() => undefined}
      />
    </QueryClientProvider>,
    size,
  );
  try {
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("Ask anything"));
    });
    await drive(setup, fixture);
    await act(async () => {
      await wait(20);
      await setup.renderOnce();
    });
    await captureFrame(
      setup,
      output,
      `${name}-${String(size.width)}x${String(size.height)}`,
    );
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    client.clear();
    commands.close();
  }
}

async function type(setup: Setup, text: string) {
  await act(async () => {
    await setup.mockInput.typeText(text);
    await setup.renderOnce();
  });
}
async function press(setup: Setup, key: "enter" | "down" | "escape") {
  await act(async () => {
    if (key === "enter") setup.mockInput.pressEnter();
    else if (key === "escape") setup.mockInput.pressEscape();
    else setup.mockInput.pressArrow("down");
    await wait(10);
    await setup.renderOnce();
  });
}
async function until(setup: Setup, text: string) {
  await act(async () => {
    await setup.waitForFrame((frame) => frame.includes(text));
  });
}
async function login(setup: Setup, provider?: string, subscription = false) {
  await type(setup, "/login");
  await press(setup, "enter");
  await until(setup, "Sign in to a model provider");
  if (provider === undefined) return;
  await type(setup, provider);
  await press(setup, "enter");
  if (provider === "OpenAI") {
    await until(setup, "How do you want to sign in to OpenAI?");
    if (subscription) await press(setup, "down");
    await press(setup, "enter");
  }
}

const sizes: readonly Size[] = [
  { width: 80, height: 30 },
  { width: 48, height: 24 },
];
const footerSnapshots = {
  idle: {
    ...representativeDesignSnapshot,
    activity: idleActivity,
    toolOutput: [],
    progress: null,
    terminals: [],
  },
  waiting: {
    ...representativeDesignSnapshot,
    activity: idleActivity,
    toolOutput: [],
    progress: null,
    terminals: [
      {
        commandId: "footer-completed",
        outcome: "completed",
        sequence: 9999,
        diagnostic: null,
      },
    ],
  },
  thinking: { ...representativeDesignSnapshot, toolOutput: [], progress: null },
  responding: representativeDesignSnapshot,
  "running-tool": longHistoryDesignSnapshot,
} satisfies Readonly<Record<string, SessionSnapshot>>;
for (const size of sizes) {
  for (const [state, snapshot] of Object.entries(footerSnapshots)) {
    await scene(
      `footer-${state}`,
      size,
      scriptedOwner(),
      () => Promise.resolve(),
      createDesignTuiFixture({ snapshot }),
    );
  }

  await scene("footer", size, scriptedOwner(), () => Promise.resolve());
  for (const confirmed of [false, true]) {
    await scene(
      confirmed ? "user-confirmed" : "user-pending",
      size,
      scriptedOwner(),
      async (setup, fixture) => {
        await type(setup, "Keep the footer readable at every width.");
        await press(setup, "enter");
        await until(setup, "Keep the footer readable");
        if (confirmed) {
          await act(async () => {
            fixture.confirmLatestPrompt();
            await setup.waitForFrame(() =>
              setup
                .captureSpans()
                .lines.some((line) =>
                  line.spans.some(
                    (span) =>
                      span.text.includes("Keep the footer readable") &&
                      !(span.attributes & 2),
                  ),
                ),
            );
          });
        }
        const row = setup
          .captureSpans()
          .lines.find((line) =>
            line.spans.some((span) =>
              span.text.includes("Keep the footer readable"),
            ),
          );
        assert.ok(row);
        assert.ok(row.spans.every((span) => !span.text.includes("●")));
        const text = row.spans.find((span) =>
          span.text.includes("Keep the footer readable"),
        );
        assert.ok(text);
        assert.equal(
          Boolean(text.attributes & 2),
          !confirmed,
          "unconfirmed user text stays dim until confirmation",
        );
      },
      createTuiFixture(),
    );
  }
  const host = createWhistleInteractionHost({ title: "Sign in" });
  const session = host.begin();
  const answer = session.interaction.prompt({
    type: "choice",
    message: "Provider",
    collapsedGroup: "More providers",
    options: [
      {
        value: "openai",
        label: "OpenAI",
        description: "ChatGPT",
        group: "Signed in",
      },
      {
        value: "anthropic",
        label: "Anthropic",
        description: "Claude",
        group: "Popular",
      },
      { value: "deepseek", label: "DeepSeek", group: "More providers" },
      {
        value: "kimi-coding",
        label: "Kimi For Coding",
        group: "More providers",
      },
      { value: "openrouter", label: "OpenRouter", group: "More providers" },
      { value: "other-a", label: "Other A", group: "More providers" },
      { value: "other-b", label: "Other B", group: "More providers" },
    ],
  });
  const grouped = await testRender(<GroupedPicker host={host} />, size);
  try {
    await act(async () => grouped.renderOnce());
    await captureFrame(
      grouped,
      output,
      `grouped-picker-${String(size.width)}x${String(size.height)}`,
    );
    await type(grouped, "kimi");
    await until(grouped, "▶ Kimi For Coding");
    await captureFrame(
      grouped,
      output,
      `grouped-search-${String(size.width)}x${String(size.height)}`,
    );
    assert.match(grouped.captureCharFrame(), /▶ Kimi For Coding/u);
    await press(grouped, "enter");
    assert.equal(await answer, "kimi-coding");
  } finally {
    act(() => {
      host.cancel();
      grouped.renderer.destroy();
    });
  }

  await scene("help", size, scriptedOwner(), async (setup) => {
    await type(setup, "/help");
    await press(setup, "enter");
    await until(setup, "Commands");
    if (size.width >= 80) assert.match(setup.captureCharFrame(), /Ctrl\+O/u);
  });
  await scene("slash", size, scriptedOwner(), async (setup) => {
    await type(setup, "/");
  });
  await scene("login-providers", size, scriptedOwner(), async (setup) => {
    await login(setup);
    // Rows come from Veil's loginAllowed; the TUI adds or hides none.
    const anthropic = registry.find((provider) => provider.id === "anthropic");
    assert.deepEqual(
      anthropic?.methods.map((method) => method.kind) ?? [],
      (["api_key", "subscription"] as const).filter((method) =>
        loginAllowed({
          providerId: "anthropic",
          method,
          host: "local",
          scope: "user",
        }),
      ),
    );
  });
  await scene("login-method", size, scriptedOwner(), async (setup) => {
    await login(setup, "Kimi");
    await until(setup, "How do you want to sign in");
  });
  await scene(
    "login-browser",
    size,
    scriptedOwner(async (_request, interaction) => {
      interaction.notify({
        type: "handoff",
        url: "https://auth.openai.com/oauth/authorize",
        message: "Complete sign-in in your browser.",
      });
      interaction.notify({ type: "progress", message: "Waiting for sign-in…" });
      await never;
    }),
    async (setup) => {
      await login(setup, "OpenAI", true);
      await until(setup, "Complete sign-in in your browser.");
    },
  );
  await scene(
    "login-key",
    size,
    scriptedOwner(async (_request, interaction) => {
      await interaction.prompt({
        type: "text",
        message: "OpenAI API key",
        secret: true,
      });
    }),
    async (setup) => {
      await login(setup, "OpenAI");
      await until(setup, "OpenAI API key");
      await type(setup, "sk-hidden-value");
      assert.doesNotMatch(setup.captureCharFrame(), /hidden-value/u);
    },
  );
  await scene(
    "login-failure",
    size,
    scriptedOwner(() =>
      Promise.reject(new Error("The provider refused this key.")),
    ),
    async (setup) => {
      await login(setup, "OpenAI");
      await until(setup, "refused");
    },
  );
  await scene(
    "login-completed",
    size,
    scriptedOwner(() => Promise.resolve()),
    async (setup) => {
      await login(setup, "OpenAI");
      await setup.waitForFrame(
        (frame) => !frame.includes("Sign in to a model provider"),
      );
      assert.doesNotMatch(setup.captureCharFrame(), /Signed in to OpenAI\./u);
    },
  );
  await scene("theme", size, scriptedOwner(), async (setup) => {
    await type(setup, "/theme");
    await press(setup, "enter");
    await until(setup, "Mocha");
  });
  const configured: readonly ProviderAccess[] = [
    { providerId: "openai", providerName: "OpenAI", type: "oauth" },
  ];
  await scene(
    "login-signed-in",
    size,
    scriptedOwner(undefined, configured),
    async (setup) => {
      await login(setup);
      await until(setup, "SIGNED IN");
      assert.match(setup.captureCharFrame(), /POPULAR/u);
    },
  );
  await scene(
    "login-account-actions",
    size,
    scriptedOwner(undefined, configured),
    async (setup) => {
      await login(setup);
      await type(setup, "OpenAI");
      await press(setup, "enter");
      await until(setup, "Switch account");
      assert.match(setup.captureCharFrame(), /Sign out/u);
    },
  );
  await scene(
    "model-providers",
    size,
    scriptedOwner(undefined, configured),
    async (setup) => {
      await type(setup, "/model");
      await press(setup, "enter");
      await until(setup, "More providers");
      assert.match(setup.captureCharFrame(), /SIGNED IN/u);
      assert.doesNotMatch(setup.captureCharFrame(), /POPULAR/u);
      const frame = setup.captureCharFrame();
      assert.match(frame, /Fungi/u);
      assert.ok(frame.indexOf("Fungi") < frame.indexOf("SIGNED IN"));
    },
  );
  await scene(
    "model",
    size,
    scriptedOwner(undefined, configured),
    async (setup) => {
      await type(setup, "/model");
      await press(setup, "enter");
      await until(setup, "SIGNED IN");
      await press(setup, "down");
      await press(setup, "down");
      await press(setup, "enter");
      await until(setup, "OpenAI · GPT-6 Sol");
    },
  );
  await scene(
    "model-fungi",
    size,
    scriptedOwner(undefined, [
      { providerId: "fungi", providerName: "Fungi", type: "oauth" },
    ]),
    async (setup) => {
      await type(setup, "/model");
      await press(setup, "enter");
      await until(setup, "SIGNED IN");
      await press(setup, "down");
      await press(setup, "enter");
      await until(setup, "Fungi · Luna");
    },
  );
  await scene("model-sign-in", size, scriptedOwner(), async (setup) => {
    await type(setup, "/model");
    await press(setup, "enter");
    await until(setup, "More providers");
    await press(setup, "down");
    await press(setup, "down");
    await press(setup, "enter");
    await until(setup, "Anthropic");
    await press(setup, "down");
    await press(setup, "enter");
    await until(setup, "How do you want to sign in to OpenAI?");
  });
  await scene("account-status", size, scriptedOwner(), async (setup) => {
    await type(setup, "/account");
    await press(setup, "enter");
    await until(setup, "configured");
  });
}
console.log("Dialog design frames captured.");
