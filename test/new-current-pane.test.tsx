import { mkdir } from "node:fs/promises";
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createAppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import { PaneWorkspace } from "../src/shell/workspace.js";
import { useDialog } from "../src/button/index.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { createTuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";
import { waitForFrame } from "./native-readiness.js";

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  test(`/new replaces the focused conversation without adding a pane (${String(width)}x${String(height)})`, async () => {
    const old = createTuiFixture({
      messages: [
        {
          id: "old-message",
          commandId: null,
          sequence: 1,
          value: {
            role: "user",
            content: "Previous conversation",
            timestamp: 1,
          },
        },
      ],
    });
    const fresh = createTuiFixture();
    const sessions = {
      old: { ...old.session, address: "fixture://old" },
      fresh: { ...fresh.session, address: "fixture://fresh" },
    };
    const acquisitions: (string | null)[] = [];
    const retired: string[] = [];
    const client = createQueryClient();
    const commands = createAppSurfaceCommandHost();
    let registry: ReturnType<typeof createPaneRegistry> | undefined;
    function Shell() {
      const dialog = useDialog();
      return (
        <QueryClientProvider client={client}>
          <PaneWorkspace
            commandHost={commands}
            theme="mocha"
            exit={() => undefined}
            openPane={() => undefined}
            dialog={dialog}
            onRegistry={(value) => {
              registry = value;
            }}
            sessions={{
              describe: () => ({ agentName: "Shiitake", themeName: "mocha" }),
              acquire: (target, signal) => {
                acquisitions.push(target.sessionId);
                signal.addEventListener(
                  "abort",
                  () => retired.push(target.sessionId ?? "fresh"),
                  { once: true },
                );
                return Promise.resolve(
                  target.sessionId === null ? sessions.fresh : sessions.old,
                );
              },
            }}
          />
        </QueryClientProvider>
      );
    }
    const setup = await testRender(<Shell />, { width, height });
    const output = process.env.PANE_CAPTURE_DIR;
    if (output) await mkdir(output, { recursive: true });
    try {
      if (!registry) throw new Error("Registry missing");
      const panes = registry;
      await act(async () => {
        await panes.open({
          kind: "conversation",
          agentId: "agent-fixture",
          sessionId: "old",
        });
      });
      await waitForFrame(setup, (frame) =>
        frame.includes("Previous conversation"),
      );
      const paneId = panes.read()[0]?.paneId;
      await captureFrame(
        setup,
        output,
        `before-new-${String(width)}x${String(height)}`,
      );
      await act(async () => {
        await setup.mockInput.typeText("/new");
        setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, () => acquisitions.includes(null));
      await waitForFrame(setup, () =>
        panes.read().every((pane) => pane.state === "ready"),
      );
      await captureFrame(
        setup,
        output,
        `after-new-${String(width)}x${String(height)}`,
      );
      expect(panes.read()).toHaveLength(1);
      expect(panes.read()[0]?.paneId).toBe(paneId);
      expect(setup.captureCharFrame()).not.toContain("Previous conversation");
      expect(acquisitions).toEqual(["old", null]);
      expect(retired).toEqual(["old"]);
      await act(async () => {
        await setup.mockInput.typeText("/new");
        setup.mockInput.pressEnter();
      });
      await waitForFrame(
        setup,
        () => acquisitions.length === 3 && retired.length === 2,
      );
      expect(panes.read()).toHaveLength(1);
      expect(panes.read()[0]?.paneId).toBe(paneId);
      expect(acquisitions).toEqual(["old", null, null]);
      expect(retired).toEqual(["old", "fresh"]);
      // Explicit pane opening remains additive.
      await act(async () => {
        await panes.open({
          kind: "conversation",
          agentId: "agent-fixture",
          sessionId: "other",
        });
      });
      expect(panes.read()).toHaveLength(2);
    } finally {
      await act(async () => {
        await registry?.dispose();
      });
      act(() => {
        setup.renderer.destroy();
      });
      commands.dispose();
      client.clear();
    }
  });
}
