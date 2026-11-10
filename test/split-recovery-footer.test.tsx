import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createRoot } from "@opentui/react";
import { openTerminalApplication } from "../src/terminal-application.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { PaneWorkspace } from "../src/shell/workspace.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import {
  PaneProvider,
  useDialog,
  usePaneViewport,
} from "../src/button/index.js";
import { useHostColors } from "../src/button/dialog-surface.js";
import { ServiceRecoveryOverlay } from "../src/panes/conversation/service-recovery.js";
import { createTuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";

function RecoveryPane() {
  const viewport = usePaneViewport();
  const colors = useHostColors();
  return (
    <ServiceRecoveryOverlay
      view={{ phase: "stuck", alive: false, seconds: 30, lastError: undefined }}
      viewport={viewport}
      colors={colors}
      onClose={() => undefined}
    />
  );
}

for (const [width, height] of [
  [60, 20],
  [80, 24],
  [100, 32],
  [120, 40],
] as const) {
  test(`recovery and activity stay readable in responsive panes at ${String(width)} columns at ${String(height)} rows`, async () => {
    const fixture = createTuiFixture({
      messages: [
        {
          id: "reply",
          commandId: "turn",
          sequence: 1,
          value: {
            role: "assistant",
            api: "pi",
            provider: "openai",
            model: "gpt-6.1-sol",
            content: [{ type: "text", text: "Ready for your next message." }],
            stopReason: "stop",
            timestamp: 1,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          },
        },
      ],
    });
    const query = createQueryClient();
    const commands = createWhistle();
    const setup = await testRender(<box />, { width, height });
    const application = await openTerminalApplication({
      signals: { on: () => undefined, off: () => undefined },
      createQueryClient: () => query,
      createRenderer: () => Promise.resolve(setup.renderer),
      createRoot,
      createWhistle: () => commands,
      enableKeymap: true,
    });
    if (application === undefined) throw new Error("Terminal did not open");
    application.inputHandoff?.pause();
    const commandHost = application.commandHost;
    let registry: ReturnType<typeof createPaneRegistry> | undefined;
    function Shell() {
      const dialog = useDialog();
      return (
        <QueryClientProvider client={query}>
          <PaneWorkspace
            commandHost={commandHost}
            sessions={{
              acquire: () => Promise.resolve(fixture.session),
              describe: () => ({
                themeName: "mocha",
                sandbox: {
                  identity: "split-sandbox",
                  rules: {
                    list: () => Promise.resolve([]),
                    remove: () => Promise.reject(new Error("unused")),
                  },
                  read: () =>
                    Promise.resolve({ mode: "workspace", available: true }),
                  setMode: () => Promise.reject(new Error("unused")),
                },
              }),
            }}
            additionalKinds={[
              {
                kind: "recovery-fixture",
                instantiate: () => ({
                  key: "recovery",
                  title: "Recovery",
                  render: (kit) => (
                    <PaneProvider kit={kit}>
                      <RecoveryPane />
                    </PaneProvider>
                  ),
                }),
              },
              {
                kind: "side-fixture",
                instantiate: () => ({
                  key: "side",
                  title: "Local terminal",
                  render: () => <text>Local terminal</text>,
                }),
              },
            ]}
            theme="mocha"
            exit={() => undefined}
            openPane={() => undefined}
            dialog={dialog}
            onRegistry={(value) => {
              registry = value;
            }}
          />
        </QueryClientProvider>
      );
    }
    await act(async () => {
      application.root.render(<Shell />);
      await setup.renderOnce();
    });
    try {
      if (registry === undefined) throw new Error("Missing pane registry");
      const panes = registry;
      await act(async () => {
        await panes.open({ kind: "conversation", ...fixture.identity });
      });
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("workspace · sandboxed")),
      );
      await captureFrame(
        setup,
        process.env.TUI_SPLIT_CAPTURE_DIR,
        `footer-full-${String(width)}x${String(height)}`,
      );
      const conversationId = panes.read()[0]?.paneId;
      await act(async () => {
        await panes.open({ kind: "side-fixture" });
      });
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Local terminal")),
      );
      if (width === 60 && conversationId !== undefined) {
        await act(async () => {
          panes.focus(conversationId);
          await setup.renderOnce();
        });
      }
      const conversation = panes
        .read()
        .find((pane) => pane.paneId === conversationId);
      if (conversation === undefined)
        throw new Error("Missing conversation pane");
      const left = setup
        .captureCharFrame()
        .split("\n")
        .map((line) =>
          line.slice(
            conversation.frame.x,
            conversation.frame.x + conversation.frame.width,
          ),
        );
      await captureFrame(
        setup,
        process.env.TUI_SPLIT_CAPTURE_DIR,
        `footer-split-${String(width)}x${String(height)}`,
      );
      const readableFooter = left.some((line) =>
        line.includes("● idle workspace · sandboxed"),
      );
      await act(async () => {
        await panes.replace(conversation.paneId, { kind: "recovery-fixture" });
      });
      await act(async () => setup.renderOnce());
      await captureFrame(
        setup,
        process.env.TUI_SPLIT_CAPTURE_DIR,
        `recovery-split-${String(width)}x${String(height)}`,
      );
      const recovery = panes
        .read()
        .find((pane) => pane.paneId === conversation.paneId);
      if (recovery === undefined) throw new Error("Missing recovery pane");
      const recoveryText = setup
        .captureCharFrame()
        .split("\n")
        .map((line) =>
          line
            .slice(recovery.frame.x, recovery.frame.x + recovery.frame.width)
            .replace(/│$/u, ""),
        )
        .join(" ")
        .replace(/\s+/gu, " ");
      const side = panes
        .read()
        .find((pane) => pane.paneId !== conversation.paneId);
      if (side === undefined) throw new Error("Missing side pane");
      await act(async () => {
        await panes.close(side.paneId);
        await setup.renderOnce();
      });
      await captureFrame(
        setup,
        process.env.TUI_SPLIT_CAPTURE_DIR,
        `recovery-full-${String(width)}x${String(height)}`,
      );
      expect(readableFooter).toBe(true);
      expect(recoveryText).toContain("The service stopped");
      expect(recoveryText).toContain(
        "Run `fungi resume` in another terminal. This conversation keeps trying and keeps your draft.",
      );
    } finally {
      await act(async () => {
        await application.close();
      });
      await fixture.waitForClose();
    }
  });
}
