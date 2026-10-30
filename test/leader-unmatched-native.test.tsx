import { expect, test } from "bun:test";
import { act } from "react";
import { TextareaRenderable } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { renderTuiConversation } from "../src/frame-renderer.js";
import { openTerminalApplication } from "../src/terminal-application.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

test("an unmatched native Ctrl-K z leaves composer text and focus unchanged", async () => {
  const setup = await testRender(<box />, { width: 80, height: 24 });
  const app = await openTerminalApplication({
    signals: { on: () => undefined, off: () => undefined },
    createQueryClient,
    createRenderer: () => Promise.resolve(setup.renderer),
    createRoot,
    createWhistle,
    enableKeymap: true,
  });
  if (app === undefined) throw new Error("Terminal did not open");
  app.inputHandoff?.pause();
  const fixture = createTuiFixture();
  try {
    await act(async () => {
      renderTuiConversation(app.root, app.queryClient, {
        session: fixture.session,
        commands: app.commands,
        commandHost: app.commandHost,
      });
      await setup.renderOnce();
    });
    await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Ask anything") &&
        setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
    );
    // z normally means Zoom. This real shell contribution deliberately offers
    // only x, so z is genuinely unmatched rather than a handled zoom command.
    act(() => {
      app.commandHost.registerShellCommands([
        {
          id: "fixture-close",
          title: "Close fixture",
          category: "Panes",
          projections: { bindings: { values: ["<leader>x"] } },
          handler: () => undefined,
        },
      ]);
    });
    const input = setup.renderer.currentFocusedRenderable;
    if (!(input instanceof TextareaRenderable))
      throw new Error("Composer input is not focused");
    await act(async () => {
      await setup.mockInput.typeText("draft");
    });
    expect(input.plainText).toBe("draft");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("k", { ctrl: true });
    });
    expect(app.keymap?.hasPendingSequence()).toBe(true);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("z");
    });
    expect(app.keymap?.hasPendingSequence()).toBe(false);
    expect(input.plainText).toBe("draft");
    expect(setup.renderer.currentFocusedRenderable).toBe(input);
    const viewport = { width: input.width, height: input.height };
    let nested = 0;
    act(() => {
      app.commandHost.registerShellCommands([
        {
          id: "fixture-nested",
          title: "Nested fixture",
          category: "Panes",
          projections: { bindings: { values: ["<leader>gx"] } },
          handler: () => {
            nested += 1;
          },
        },
      ]);
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("k", { ctrl: true });
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("g");
    });
    expect(app.keymap?.getPendingSequence()).toHaveLength(2);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressBackspace();
    });
    expect(app.keymap?.getPendingSequence()).toHaveLength(1);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("g");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("x");
    });
    expect(nested).toBe(1);
    expect(app.keymap?.hasPendingSequence()).toBe(false);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("k", { ctrl: true });
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("g");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEscape();
    });
    expect(app.keymap?.hasPendingSequence()).toBe(false);
    expect(input.plainText).toBe("draft");
    expect({ width: input.width, height: input.height }).toEqual(viewport);
    expect(setup.renderer.currentFocusedRenderable).toBe(input);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("!");
    });
    expect(input.plainText).toBe("draft!");
    await act(async () => {
      await fixture.session.command({
        type: "prompt",
        requestId: "leader-active-turn",
        text: "Keep working",
        delivery: "followUp",
      });
    });
    await waitForFrame(
      setup,
      (frame) => frame.includes("Keep working") && frame.includes("● idle"),
    );
    for (const state of ["queued", "running"]) {
      if (state === "running") {
        act(() => {
          fixture.confirmLatestPrompt();
        });
        await waitForFrame(setup, (frame) =>
          frame.includes("Fixture is streaming a reply."),
        );
      }
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("k", { ctrl: true });
      });
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("g");
      });
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEscape();
      });
      expect(app.keymap?.hasPendingSequence()).toBe(false);
      expect(fixture.abortCalls()).toBe(0);
      expect(fixture.cancelCalls()).toEqual([]);
      expect(input.plainText).toBe("draft!");
    }
  } finally {
    await act(async () => {
      await app.close();
    });
  }
});
