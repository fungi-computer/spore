import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import type { WhistlePrompt } from "@fungi.computer/whistle";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import type { PrivateLocalSessionChoice } from "@fungi.computer/truffle/service";
import { SessionPicker } from "../src/session-picker.js";

/** Set MODAL_RENDER_OUT to also save every render as a text file. */
const renderOut = process.env.MODAL_RENDER_OUT;

const rows = (...labels: readonly string[]) =>
  labels.map((label, index) => ({ value: String(index), label }));

const providerStep: WhistlePrompt = {
  type: "choice",
  message: "Choose a provider",
  summary: "Or follow the Agent's own model.",
  current: "2",
  options: rows("Use agent model", "Fungi", "OpenAI", "Anthropic"),
};
const modelStep: WhistlePrompt = {
  type: "choice",
  message: "Choose a model",
  summary: "Models from OpenAI.",
  current: "0",
  options: rows("GPT-6.1 Sol", "GPT-6.1 Luna", "GPT-6.1 Astra"),
};
const thinkingStep: WhistlePrompt = {
  type: "choice",
  message: "Thinking level for GPT-6.1 Sol",
  summary: "How long the model thinks before it answers.",
  current: "2",
  options: rows("Model default", "low", "medium", "high"),
};
const loginProvider: WhistlePrompt = {
  type: "choice",
  message: "Sign in to a model provider",
  summary: "Use a subscription or an API key. You can add more later.",
  options: [
    {
      value: "openai",
      label: "OpenAI",
      description: "Subscription",
      group: "Signed in",
    },
    {
      value: "anthropic",
      label: "Anthropic",
      description: "Subscription or API key",
      group: "Popular",
    },
    {
      value: "google",
      label: "Google",
      description: "API key",
      group: "Popular",
    },
  ],
};
const signedIn: WhistlePrompt = {
  type: "choice",
  message: "Already signed in to OpenAI",
  summary: "Switch to another account, or sign out of this one.",
  options: [
    { value: "switch", label: "Switch account" },
    { value: "logout", label: "Sign out…", destructive: true },
  ],
};
const signOut: WhistlePrompt = {
  type: "confirmation",
  message: "Sign out of OpenAI?",
  summary: "Conversations on this device stop using this account.",
  confirmLabel: "Sign out",
  cancelLabel: "Keep signed in",
  destructive: true,
};
const fork: WhistlePrompt = {
  type: "choice",
  message: "Fork from which message?",
  summary: "Start a new conversation from your message.",
  options: [
    {
      value: "m3",
      label: "Add a picker for the model and keep it marked",
      description: "14:02",
    },
    {
      value: "m2",
      label: "Why does the resume list drop today's sessions?",
      description: "Yesterday",
    },
    {
      value: "m1",
      label: "Fix the long label that wraps in the fork picker",
      description: "2026-10-24",
    },
  ],
};
const home: WhistlePrompt = {
  type: "choice",
  message: "Choose a Home Computer",
  summary: "The Agent reads and edits files here by default.",
  current: "laptop",
  options: [
    { value: "laptop", label: "laptop" },
    { value: "box", label: "box" },
  ],
};
const manualCode: WhistlePrompt = {
  type: "text",
  message: "Paste the code from your browser",
  summary:
    "Connecting over SSH? Paste the URL here instead of opening a browser.",
};

/** What the same pickers looked like before the shared anatomy. */
const before = {
  "model-provider": {
    type: "choice",
    message: "Model",
    options: [
      { value: "d", label: "Use agent model" },
      { value: "f", label: "Fungi", group: "Default" },
      {
        value: "o",
        label: "OpenAI",
        description: "Subscription",
        group: "Signed in",
      },
    ],
  },
  "model-model": {
    type: "choice",
    message: "Model",
    options: [
      { value: "0", label: "OpenAI · GPT-6.1 Sol (current)" },
      { value: "1", label: "OpenAI · GPT-6.1 Luna" },
    ],
  },
  thinking: {
    type: "choice",
    message: "Thinking level for GPT-6.1 Sol",
    options: [
      { value: "d", label: "Model default" },
      { value: "m", label: "medium (current)" },
    ],
  },
  "sign-out": {
    type: "confirmation",
    message: "Sign out of OpenAI? Local Sessions stop using this account.",
    confirmLabel: "Sign out",
    cancelLabel: "Keep signed in",
  },
  home: {
    type: "choice",
    message: "Choose this Agent's Home Computer",
    options: [
      { value: "laptop", label: "laptop" },
      { value: "box", label: "box" },
    ],
  },
} satisfies Record<string, WhistlePrompt>;

async function render(
  node: (
    colors: ReturnType<typeof useTerminalTheme>["colors"],
  ) => React.ReactNode,
  size: { width: number; height: number },
) {
  function Frame() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <DialogSurface colors={colors} onClose={() => undefined}>
        {node(colors)}
      </DialogSurface>
    );
  }
  const setup = await testRender(<Frame />, size);
  for (let pass = 0; pass < 3; pass += 1)
    await act(async () => {
      await setup.renderOnce();
    });
  const text = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();
  const save = async (name: string) => {
    if (renderOut === undefined) return;
    await mkdir(renderOut, { recursive: true });
    await writeFile(join(renderOut, `${name}.txt`), `${text()}\n`);
  };
  return {
    setup,
    text,
    save,
    destroy: () => {
      act(() => {
        setup.renderer.destroy();
      });
    },
  };
}

async function open(
  prompt: WhistlePrompt,
  size: { width: number; height: number },
) {
  const host = createWhistleInteractionHost({ title: "Picker" });
  const answered: unknown[] = [];
  void host
    .begin()
    .interaction.prompt(prompt)
    .then((value) => answered.push(value));
  const modal = await render(
    (colors) => (
      <InteractionView host={host} colors={colors} onClose={() => undefined} />
    ),
    size,
  );
  const enter = async () => {
    act(() => {
      modal.setup.mockInput.pressEnter();
    });
    await act(async () => modal.setup.renderOnce());
  };
  return { ...modal, answered, enter };
}

const sizes = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
] as const;

const pickers = {
  "model-provider": providerStep,
  "model-model": modelStep,
  "model-thinking": thinkingStep,
  "login-provider": loginProvider,
  "login-signed-in": signedIn,
  "login-sign-out": signOut,
  fork,
  home,
  "login-manual-code": manualCode,
} as const;

for (const size of sizes) {
  for (const [name, prompt] of Object.entries(pickers)) {
    test(`${name} picker at ${String(size.width)} columns`, async () => {
      const modal = await open(prompt, size);
      try {
        const frame = modal.text();
        expect(frame).toMatchSnapshot();
        // Every row fits the 64 cells of dialog content.
        expect(frame).not.toContain("(current)");
        await modal.save(`after-${name}-${String(size.width)}`);
      } finally {
        modal.destroy();
      }
    });
  }
}

test("before renders for the receipts", async () => {
  for (const [name, prompt] of Object.entries(before)) {
    const modal = await open(prompt, { width: 80, height: 24 });
    try {
      await modal.save(`before-${name}-80`);
    } finally {
      modal.destroy();
    }
  }
});

test("the highlight starts on the current choice and Enter keeps it", async () => {
  for (const [name, expected] of [
    ["model-provider", "2"],
    ["model-model", "0"],
    ["model-thinking", "2"],
    ["home", "laptop"],
  ] as const) {
    const modal = await open(pickers[name], sizes[0]);
    try {
      const frame = modal.text();
      expect(frame).toMatch(/▶ ● |▶ {1,3}●/u);
      await modal.enter();
      expect(modal.answered).toEqual([expected]);
    } finally {
      modal.destroy();
    }
  }
});

test("sign-out confirmation focuses Keep and Enter cancels", async () => {
  const modal = await open(signOut, sizes[0]);
  try {
    expect(modal.text()).toContain("▶ Keep signed in");
    await modal.enter();
    expect(modal.answered).toEqual([false]);
  } finally {
    modal.destroy();
  }
});

test("no raw IDs reach the main view of the pickers", async () => {
  for (const [name, prompt] of Object.entries(pickers)) {
    const modal = await open(prompt, sizes[0]);
    try {
      expect(modal.text(), name).not.toMatch(/agent_|att_|provider_id|entry/iu);
    } finally {
      modal.destroy();
    }
  }
});

const session = (title: string, updatedAt: number) => ({
  databasePath: "/not-rendered.sqlite",
  sessionId: title,
  title,
  createdAt: 1,
  updatedAt,
  resume: () => Promise.reject(new Error("Not resumed in this test.")),
});
const sessions: readonly PrivateLocalSessionChoice[] = [
  session("Repair the local host", Date.now()),
  session("Older work", Date.now() - 86_400_000),
  session("", new Date(2026, 9, 1, 12).getTime()),
];

for (const size of sizes) {
  test(`resume picker at ${String(size.width)} columns`, async () => {
    const setup = await testRender(
      <SessionPicker
        sessions={sessions}
        onCancel={() => undefined}
        onSelect={() => undefined}
        themeError="Your saved theme could not be read, so the default is used."
      />,
      size,
    );
    for (let pass = 0; pass < 3; pass += 1)
      await act(async () => setup.renderOnce());
    try {
      const frame = setup
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd();
      expect(frame).toContain("Resume a conversation");
      expect(frame).toContain("Yesterday");
      expect(frame).toContain("2026-10-01");
      expect(frame).toContain("Untitled");
      expect(frame).toContain("Your saved theme could not be read");
      if (renderOut !== undefined) {
        await mkdir(renderOut, { recursive: true });
        await writeFile(
          join(renderOut, `after-resume-${String(size.width)}.txt`),
          `${frame}\n`,
        );
      }
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}
