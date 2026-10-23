import { expect, test } from "bun:test";
import { act, useSyncExternalStore } from "react";
import {
  contributeAccountCommands,
  createParakeetInteractions,
  type AccountOwner,
} from "@fungi.computer/parakeet/headless";
import { createWhistle } from "@fungi.computer/whistle";
import { testRender } from "@opentui/react/test-utils";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { captureFrame } from "./frame-capture.js";

function View({
  host,
  onClose = () => undefined,
}: Readonly<{
  host: ReturnType<typeof createWhistleInteractionHost>;
  onClose?: () => void;
}>) {
  const { colors } = useTerminalTheme("mocha");
  return <InteractionView host={host} colors={colors} onClose={onClose} />;
}

function Conversation({
  store,
}: Readonly<{ store: ReturnType<typeof createParakeetInteractions> }>) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  return state.open === undefined ? (
    <text>{state.notice?.message ?? "Conversation"}</text>
  ) : (
    <View host={state.open.host} onClose={store.close} />
  );
}

test.each([
  { width: 80, height: 24 },
  { width: 160, height: 48 },
])(
  "Try again keeps the chosen provider and method and retries only login at %p",
  async ({ width, height }) => {
    const runtime = createWhistle();
    const store = createParakeetInteractions();
    store.attach(runtime.present);
    const calls: Parameters<AccountOwner["login"]>[0][] = [];
    let providerReads = 0;
    const completion = Promise.withResolvers<undefined>();
    const owner: AccountOwner = {
      popularProviderIds: ["alpha", "beta"],
      access: () => Promise.resolve([]),
      providers: () => {
        providerReads += 1;
        return Promise.resolve([
          {
            id: "alpha",
            name: "Alpha",
            methods: [{ kind: "api_key", label: "Key" }],
          },
          {
            id: "beta",
            name: "Beta",
            methods: [
              { kind: "api_key", label: "Beta key" },
              { kind: "subscription", label: "Beta subscription" },
            ],
          },
        ]);
      },
      login: (request, interaction) => {
        calls.push(request);
        return calls.length === 1
          ? Promise.reject(new Error("The sign-in service is unavailable."))
          : completion.promise.then(() => {
              interaction.notify({
                type: "success",
                message: "Connected to Beta.",
              });
            });
      },
      logout: () => Promise.resolve(),
      status: () => Promise.resolve("Signed out"),
    };
    contributeAccountCommands(runtime, owner, {
      sourceId: "account",
      namespace: "account",
      host: "local",
      scope: "user",
      policy: { loginAllowed: () => true },
    });
    const setup = await testRender(<Conversation store={store} />, {
      width,
      height,
    });
    const running = runtime.execute("account:login", { origin: "slash" });
    try {
      await act(async () =>
        setup.waitForFrame((frame) =>
          frame.includes("Choose a model provider"),
        ),
      );
      act(() => {
        setup.mockInput.pressArrow("down");
        setup.mockInput.pressEnter();
      });
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Beta subscription")),
      );
      act(() => {
        setup.mockInput.pressArrow("down");
        setup.mockInput.pressEnter();
      });
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Try again")),
      );
      await captureFrame(
        setup,
        process.env.LOGIN_RETRY_CAPTURE_DIR,
        `${String(width)}x${String(height)}-before-retry`,
      );
      act(() => {
        setup.mockInput.pressEnter();
      });
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Signing in to Beta")),
      );
      expect(calls).toEqual([
        { providerId: "beta", method: "subscription" },
        { providerId: "beta", method: "subscription" },
      ]);
      expect(providerReads).toBe(1);
      expect(setup.captureCharFrame()).not.toContain("Choose a model provider");
      await captureFrame(
        setup,
        process.env.LOGIN_RETRY_CAPTURE_DIR,
        `${String(width)}x${String(height)}-after-retry`,
      );
      completion.resolve(undefined);
      await act(async () => {
        await running;
      });
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Connected to Beta.")),
      );
      expect(store.snapshot().open?.host.snapshot().status).toBe("done");
      await captureFrame(
        setup,
        process.env.LOGIN_RETRY_CAPTURE_DIR,
        `${String(width)}x${String(height)}-completed`,
      );
      act(() => {
        setup.mockInput.pressEnter();
      });
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Conversation")),
      );
      expect(store.snapshot().open).toBeUndefined();
    } finally {
      store.close();
      completion.resolve(undefined);
      await running;
      act(() => {
        setup.renderer.destroy();
      });
      runtime.close();
    }
  },
);

test.each(["enter", "2"])(
  "%s submits and closes a single choice with no second Enter",
  async (key) => {
    const runtime = createWhistle();
    const store = createParakeetInteractions();
    store.attach(runtime.present);
    runtime.contribute({
      sourceId: "question",
      namespace: "question",
      commands: [
        {
          id: "answer",
          title: "Answer a question",
          category: "Conversation",
          handler: async ({ interaction }) => {
            if (interaction === undefined) throw new Error("Missing presenter");
            await interaction.prompt({
              type: "choice",
              message: "Which store should hold the notes?",
              options: [
                { value: "sqlite", label: "SQLite" },
                { value: "postgres", label: "PostgreSQL" },
              ],
            });
            interaction.notify({ type: "success", message: "Answer sent." });
          },
        },
      ],
    });
    const setup = await testRender(<Conversation store={store} />, {
      width: 72,
      height: 20,
    });
    const { running } = await act(() => ({
      running: runtime.execute("question:answer", { origin: "slash" }),
    }));
    try {
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("PostgreSQL")),
      );
      await captureFrame(
        setup,
        process.env.QUESTION_CAPTURE_DIR,
        `submit-${key}-before`,
      );
      await act(async () => {
        if (key === "enter") setup.mockInput.pressEnter();
        else await setup.mockInput.typeText(key);
      });
      await act(async () => setup.renderOnce());
      await captureFrame(
        setup,
        process.env.QUESTION_CAPTURE_DIR,
        `submit-${key}-after`,
      );
      expect(store.snapshot().open).toBeUndefined();
      expect(store.snapshot().notice).toBeUndefined();
      expect(setup.captureCharFrame()).not.toContain("Answer sent.");
      await running;
    } finally {
      store.close();
      await running;
      act(() => {
        setup.renderer.destroy();
      });
      runtime.close();
    }
  },
);

test("a number key answers a choice without Enter", async () => {
  const host = createWhistleInteractionHost({ title: "Answer a question" });
  const session = host.begin();
  const setup = await testRender(<View host={host} />, {
    width: 72,
    height: 20,
  });
  let chosen: string | undefined;
  // Input completes this promise; only its admission belongs in this act.
  const { answer } = await act(() => ({
    answer: session.interaction.prompt({
      type: "choice",
      message: "Which store should hold the notes?",
      options: [
        { value: "sqlite", label: "SQLite" },
        { value: "postgres", label: "PostgreSQL" },
      ],
    }),
  }));
  void answer.then((value) => {
    chosen = value;
  });
  try {
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("PostgreSQL"));
    });
    await captureFrame(
      setup,
      process.env.QUESTION_CAPTURE_DIR,
      "choice-before",
    );
    await act(async () => setup.mockInput.typeText("2"));
    await act(async () => setup.renderOnce());
    await captureFrame(setup, process.env.QUESTION_CAPTURE_DIR, "choice-after");
    expect(chosen).toBe("postgres");
  } finally {
    // Settle even on the red so the pending prompt does not outlive its view.
    act(() => {
      host.answer(host.snapshot().prompt?.sequence ?? -1, "sqlite");
    });
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a choice prompt answers with the chosen option's value", async () => {
  const host = createWhistleInteractionHost({ title: "Sign in" });
  const session = host.begin();
  const setup = await testRender(<View host={host} />, {
    width: 72,
    height: 20,
  });
  try {
    const { answer } = await act(() => ({
      answer: session.interaction.prompt({
        type: "choice",
        message: "Choose a model provider",
        options: [
          { value: "alpha", label: "Alpha", description: "Alpha API key" },
          { value: "beta", label: "Beta", description: "Beta Max" },
        ],
      }),
    }));
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("Alpha API key"));
    });
    act(() => {
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressEnter();
    });
    expect(await answer).toBe("beta");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a secret is never drawn and a handoff shows its code", async () => {
  const host = createWhistleInteractionHost({ title: "Sign in" });
  const session = host.begin();
  const setup = await testRender(<View host={host} />, {
    width: 72,
    height: 20,
  });
  try {
    const { answer } = await act(() => {
      session.interaction.notify({
        type: "handoff",
        url: "https://auth.example.test/device",
        code: "WDJB-MJHT",
      });
      return {
        answer: session.interaction.prompt({
          type: "text",
          message: "API key",
          secret: true,
        }),
      };
    });
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("WDJB-MJHT"));
    });
    await act(async () => setup.mockInput.typeText("sk-hidden"));
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).not.toContain("sk-hidden");
    expect(setup.captureCharFrame()).toContain("9 characters");
    act(() => {
      setup.mockInput.pressEnter();
    });
    expect(await answer).toBe("sk-hidden");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("Escape cancels the interaction and closes the view", async () => {
  const host = createWhistleInteractionHost({ title: "Sign in" });
  const session = host.begin();
  let closed = 0;
  const setup = await testRender(
    <View
      host={host}
      onClose={() => {
        closed += 1;
      }}
    />,
    { width: 72, height: 20 },
  );
  try {
    act(() => {
      session.interaction.notify({ type: "progress", message: "Waiting" });
    });
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("Waiting"));
    });
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await setup.renderOnce();
    });
    expect(session.interaction.signal.aborted).toBe(true);
    expect(closed).toBe(1);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a blank text answer can skip optional context", async () => {
  const host = createWhistleInteractionHost({ title: "Answer a question" });
  const session = host.begin();
  const setup = await testRender(<View host={host} />, {
    width: 72,
    height: 20,
  });
  const { answer } = await act(() => ({
    answer: session.interaction.prompt({
      type: "text",
      message: "Additional context (leave blank to skip):",
    }),
  }));
  try {
    await act(async () => {
      await setup.waitForFrame((frame) =>
        frame.includes("leave blank to skip"),
      );
      setup.mockInput.pressEnter();
      await setup.renderOnce();
    });
    expect(await answer).toBe("");
    act(() => {
      host.cancel();
    });
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const kind of [
  "handoff",
  "message",
  "prompt",
  "failed",
  "placeholder",
] as const) {
  test(`interaction ${kind} displays remote strings without terminal programs`, async () => {
    const payload = "safe\u001b]52;c;Y21k\u0007\u009d\u0090\u202e end";
    const host = createWhistleInteractionHost({ title: payload });
    const session = host.begin();
    const setup = await testRender(<View host={host} />, {
      width: 100,
      height: 30,
    });
    try {
      act(() => {
        if (kind === "handoff")
          session.interaction.notify({
            type: "handoff",
            message: payload,
            url: `https://example.test/${payload}`,
            code: payload,
          });
        else if (kind === "message")
          session.interaction.notify({
            type: "info",
            message: payload,
            links: [{ label: payload, url: `https://example.test/${payload}` }],
          });
        else if (kind === "failed")
          session.settle({ status: "failed", message: payload });
        else {
          const answer = session.interaction.prompt({
            type: "text",
            message: kind === "placeholder" ? "Enter text" : payload,
            placeholder: kind === "placeholder" ? payload : undefined,
          });
          // Keep the prompt alive while its native view is inspected.
          void answer.catch((cause: unknown) => {
            return cause;
          });
        }
      });
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("safe")),
      );
      expect(setup.captureCharFrame()).not.toMatch(
        /[^\P{Cc}\n\t]|[\u202a-\u202e\u2066-\u2069]/u,
      );
      expect(setup.captureCharFrame()).toContain("safe end");
    } finally {
      act(() => {
        host.cancel();
      });
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}
