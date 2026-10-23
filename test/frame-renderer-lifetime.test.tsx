import { test, expect } from "bun:test";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { openTerminalApplication } from "../src/terminal-application.js";
import { renderTuiConversation } from "../src/frame-renderer.js";
import { createTuiFixture } from "./fixture.js";
import { waitForFrame } from "./native-readiness.js";
import { enterReactActEnvironment } from "./native-renderer-cleanup.js";

test("the production frame releases closed entries, retains the empty shell and admits a fresh Session", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const restoreActEnvironment = enterReactActEnvironment();
  try {
    const app = await openTerminalApplication({
      signals: { on: () => undefined, off: () => undefined },
      createRenderer: () => Promise.resolve(setup.renderer),
      createRoot,
      createQueryClient,
      createWhistle,
      enableKeymap: true,
    });
    if (app === undefined) throw new Error("Terminal did not open");
    const first = createTuiFixture();
    const fresh = createTuiFixture();
    let released = 0;
    const open = (fixture: ReturnType<typeof createTuiFixture>) => {
      renderTuiConversation(app.root, app.queryClient, {
        session: fixture.session,
        commands: app.commands,
        commandHost: app.commandHost,
        initialTheme: "mocha",
        onExit: app.exit,
        target: { kind: "conversation", agentId: "alpha", sessionId: "one" },
        onClose: () => {
          released += 1;
        },
      });
    };
    const close = async () => {
      const command = app.commandHost
        .active()
        .palette.find((row) => row.title === "Close pane");
      if (command === undefined) throw new Error("Close pane is not available");
      await act(async () => {
        expect(
          (
            await app.commandHost.execute(command.commandId, {
              origin: "programmatic",
            })
          ).status,
        ).toBe("handled");
      });
    };
    try {
      await act(async () => {
        open(first);
        await setup.renderOnce();
      });
      await waitForFrame(setup, () =>
        setup.captureCharFrame().includes("Ask anything"),
      );
      await close();
      await first.waitForClose();
      await waitForFrame(setup, () =>
        setup.captureCharFrame().includes("No panes open"),
      );
      expect(released).toBe(1);
      await act(async () => {
        open(fresh);
        await setup.renderOnce();
      });
      await waitForFrame(setup, () =>
        setup.captureCharFrame().includes("Ask anything"),
      );
      expect(first.abortCalls()).toBe(0);
      expect(first.cancelCalls()).toEqual([]);
      await close();
      await fresh.waitForClose();
      expect(released).toBe(2);
    } finally {
      await act(async () => {
        app.exit();
        await app.close();
      });
    }
  } finally {
    restoreActEnvironment();
  }
});
