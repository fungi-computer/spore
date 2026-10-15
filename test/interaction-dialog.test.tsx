import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

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

test("a choice prompt answers with the chosen option's value", async () => {
  const host = createWhistleInteractionHost({ title: "Sign in" });
  const session = host.begin();
  const setup = await testRender(<View host={host} />, {
    width: 72,
    height: 20,
  });
  try {
    const answer = session.interaction.prompt({
      type: "choice",
      message: "Choose a model provider",
      options: [
        { value: "alpha", label: "Alpha", description: "Alpha API key" },
        { value: "beta", label: "Beta", description: "Beta Max" },
      ],
    });
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
    session.interaction.notify({
      type: "handoff",
      url: "https://auth.example.test/device",
      code: "WDJB-MJHT",
    });
    const answer = session.interaction.prompt({
      type: "text",
      message: "API key",
      secret: true,
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
    session.interaction.notify({ type: "progress", message: "Waiting" });
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
  const answer = session.interaction.prompt({
    type: "text",
    message: "Additional context (leave blank to skip):",
  });
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
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("safe")),
      );
      expect(setup.captureCharFrame()).not.toMatch(
        /[^\P{Cc}\n\t]|[\u202a-\u202e\u2066-\u2069]/u,
      );
      expect(setup.captureCharFrame()).toContain("safe end");
    } finally {
      host.cancel();
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}
