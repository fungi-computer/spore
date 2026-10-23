import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { renderTuiConversation } from "../src/frame-renderer.js";
import { openTerminalApplication } from "../src/terminal-application.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

test("native leader hints preserve pane input focus and close without a choice dialog", async () => {
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
        setup.renderer.currentFocusedRenderable?.id !== undefined,
    );
    const input = setup.renderer.currentFocusedRenderable?.id;
    expect(input).toBeDefined();
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("k", { ctrl: true });
    });
    const hints = await waitForFrame(setup, (frame) =>
      frame.includes("Close pane"),
    );
    // A which-key hint does not replace the pane's focused input with a picker.
    expect(setup.renderer.currentFocusedRenderable?.id).toBe(input);
    expect(hints).not.toContain("↑↓ choose");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("x");
    });
    await waitForFrame(setup, (frame) => frame.includes("No panes open"));
  } finally {
    await act(async () => {
      await app.close();
    });
  }
});
