import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { Field } from "../src/button/field.js";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { Placeholder } from "../src/button/placeholder.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { pressDecodedKey } from "./native-readiness.js";

test("a secret Field draws only its length and submits its value", async () => {
  const submitted: string[] = [];
  function Secret() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <Field
        secret
        maxLength={64}
        onSubmit={(value) => submitted.push(value)}
        colors={colors}
      />
    );
  }
  const setup = await testRender(<Secret />, { width: 60, height: 4 });
  try {
    await act(async () => {
      await setup.mockInput.typeText("hunter2");
      setup.mockInput.pressEnter();
    });
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).not.toContain("hunter2");
    expect(setup.captureCharFrame()).toContain("7 characters");
    expect(submitted).toEqual(["hunter2"]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("Placeholder colors each state and names its one action", async () => {
  function States() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <box flexDirection="column">
        <Placeholder state="loading" message="Loading rows" colors={colors} />
        <Placeholder
          state="signed-out"
          message="Sign in to Fungi to see Apps"
          action="Run /login and choose Fungi"
          colors={colors}
        />
        <Placeholder state="error" message="It broke" colors={colors} />
      </box>
    );
  }
  const setup = await testRender(<States />, { width: 60, height: 6 });
  try {
    await act(async () => setup.renderOnce());
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const color = (text: string) =>
      spans.find((span) => span.text.includes(text))?.fg.toInts();
    expect(setup.captureCharFrame()).toContain("Run /login and choose Fungi");
    expect(color("Sign in to Fungi")).not.toEqual(color("Loading rows"));
    expect(color("It broke")).not.toEqual(color("Sign in to Fungi"));
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a dialog without a prompt holds Esc itself, with no global keyboard hook", async () => {
  const host = createWhistleInteractionHost({ title: "Signing in" });
  host.begin();
  let closed = 0;
  function View() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <InteractionView
        host={host}
        colors={colors}
        onClose={() => {
          closed += 1;
        }}
      />
    );
  }
  const setup = await testRender(<View />, { width: 72, height: 12 });
  try {
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("Esc cancel"));
    });
    expect(setup.renderer.currentFocusedRenderable?.focused).toBe(true);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEscape();
    });
    expect(closed).toBe(1);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
