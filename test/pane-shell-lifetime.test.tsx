import { mkdir } from "node:fs/promises";
import { captureFrame } from "./frame-capture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";
import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { openTerminalApplication } from "../src/terminal-application.js";
import { PaneWorkspace } from "../src/shell/workspace.js";
import { useDialog } from "../src/button/index.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { createTuiFixture } from "./fixture.js";

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  test(`real conversation panes retain drafts and release views without cancelling work (${String(width)}x${String(height)})`, async () => {
    const setup = await testRender(<box />, { width, height });
    const application = await openTerminalApplication({
      signals: { on: () => undefined, off: () => undefined },
      createQueryClient,
      createRenderer: () => Promise.resolve(setup.renderer),
      createRoot,
      createWhistle,
      enableKeymap: true,
    });
    if (application === undefined) throw new Error("Terminal did not open");
    const output = process.env.PANE_CAPTURE_DIR;
    if (output !== undefined) await mkdir(output, { recursive: true });
    const capture = async (name: string) =>
      captureFrame(setup, output, `${name}-${String(width)}x${String(height)}`);
    const app = application;
    app.inputHandoff?.pause();
    const alpha = createTuiFixture({
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `history-${String(index)}`,
        commandId: `history-${String(index)}`,
        sequence: index + 1,
        value: {
          role: "user" as const,
          content: `History ${String(index + 1)}`,
          timestamp: index + 1,
        },
      })),
    });
    const beta = createTuiFixture();
    const sessions = {
      alpha: { ...alpha.session, address: "fixture://alpha/session" },
      beta: { ...beta.session, address: "fixture://beta/session" },
    };
    let registry: ReturnType<typeof createPaneRegistry> | undefined;
    const ready = (value: ReturnType<typeof createPaneRegistry>) => {
      registry = value;
    };
    const services = {
      describe: () => ({ themeName: "mocha" as const }),
      acquire: (target: { agentId: string }) => {
        if (target.agentId === "alpha") return Promise.resolve(sessions.alpha);
        if (target.agentId === "beta") return Promise.resolve(sessions.beta);
        throw new Error("Session fixture unavailable");
      },
    };
    function Shell() {
      const dialog = useDialog();
      return (
        <QueryClientProvider client={app.queryClient}>
          <PaneWorkspace
            commandHost={app.commandHost}
            sessions={services}
            theme="mocha"
            exit={app.exit}
            openPane={() => undefined}
            dialog={dialog}
            onRegistry={ready}
          />
        </QueryClientProvider>
      );
    }
    const frame = async (predicate: (text: string) => boolean) =>
      act(async () => setup.waitForFrame(predicate));
    const key = async (
      name: Parameters<typeof setup.mockInput.pressKey>[0],
      options?: Parameters<typeof setup.mockInput.pressKey>[1],
    ) => {
      await act(async () => {
        setup.mockInput.pressKey(name, options);
        await setup.renderOnce();
      });
    };
    try {
      await act(async () => {
        application.root.render(<Shell />);
        await setup.renderOnce();
      });
      if (registry === undefined) throw new Error("Registry did not mount");
      const panes = registry;
      await act(async () => {
        await panes.open({
          kind: "conversation",
          agentId: "alpha",
          sessionId: "one",
        });
      });
      await frame((text) => text.includes("Ask anything"));
      await act(async () => {
        await setup.mockInput.typeText("alpha draft");
      });
      await frame((text) => text.includes("alpha draft"));
      await act(async () => {
        await panes.open({
          kind: "conversation",
          agentId: "beta",
          sessionId: "two",
        });
      });
      await act(async () => {
        await setup.mockInput.typeText("beta draft");
      });
      await frame(
        (text) => text.includes("beta draft") && text.includes("alpha draft"),
      );
      const firstPane = panes.read().find((pane) => !pane.focused);
      const secondPane = panes.read().find((pane) => pane.focused);
      if (firstPane === undefined || secondPane === undefined)
        throw new Error("Two pane views missing");
      await capture("two-conversations");
      const viewports = descendants(setup.renderer.root).filter(
        (node) => node instanceof ScrollBoxRenderable,
      );
      expect(viewports).toHaveLength(2);
      for (const viewport of viewports) expect(viewport.viewport.y).toBe(1);
      const emptyViewport = viewports.find(
        (viewport) => viewport.x >= secondPane.frame.x,
      );
      expect(emptyViewport?.verticalScrollBar.visible).toBe(false);
      for (const viewport of viewports)
        expect(viewport.horizontalScrollBar.visible).toBe(false);
      expect(
        setup
          .captureCharFrame()
          .split("\n")
          .every((line) => !line.endsWith("│")),
      ).toBe(true);
      // The real production keymap and shared leader drive the registry.
      await key("k", { ctrl: true });
      await frame((text) => text.includes("All commands"));
      await key("z");
      await frame(
        (text) => text.includes("beta draft") && !text.includes("alpha draft"),
      );
      await capture("zoomed");
      expect(alpha.closeCalls()).toBe(0);
      expect(beta.closeCalls()).toBe(0);
      await key("k", { ctrl: true });
      await key("z");
      await frame(
        (text) => text.includes("beta draft") && text.includes("alpha draft"),
      );
      act(() => {
        panes.focus(firstPane.paneId);
      });
      await act(async () => {
        await setup.mockInput.typeText(" kept");
      });
      await frame(
        (text) =>
          text.includes("alpha draft kept") && text.includes("beta draft"),
      );
      act(() => {
        panes.split("y");
        panes.resizeBy(2);
      });
      expect(panes.read()).toHaveLength(2);
      await key("k", { ctrl: true });
      await frame((text) => text.includes("All commands"));
      await key("x");
      await frame(
        (text) =>
          !text.includes("alpha draft kept") && text.includes("beta draft"),
      );
      await alpha.waitForClose();
      expect(alpha.abortCalls()).toBe(0);
      expect(alpha.cancelCalls()).toEqual([]);
      await frame(
        (text) => text.includes("beta draft") && !text.includes("alpha draft"),
      );
      await act(async () => {
        await panes.close(secondPane.paneId);
      });
      await beta.waitForClose();
      await frame((text) => text.includes("No panes open"));
      await capture("empty-shell");
      expect(beta.abortCalls()).toBe(0);
      expect(beta.cancelCalls()).toEqual([]);
      expect(
        application.commandHost
          .active()
          .slash.some((row) => row.alias === "clear"),
      ).toBe(false);
      await act(async () => {
        await panes.open({
          kind: "conversation",
          agentId: "alpha",
          sessionId: "one",
        });
      });
      await frame(
        (text) =>
          text.includes("Ask anything") && !text.includes("No panes open"),
      );
      expect(panes.read()).toHaveLength(1);
    } finally {
      await act(async () => {
        await application.close();
      });
    }
  });
}

test("real pane keymap cancels only the focused conversation", async () => {
  const setup = await testRender(<box />, { width: 160, height: 48 });
  const application = await openTerminalApplication({
    signals: { on: () => undefined, off: () => undefined },
    createQueryClient,
    createRenderer: () => Promise.resolve(setup.renderer),
    createRoot,
    createWhistle,
    enableKeymap: true,
  });
  if (application === undefined) throw new Error("Terminal did not open");
  const app = application;
  app.inputHandoff?.pause();
  const alpha = createTuiFixture();
  const beta = createTuiFixture();
  let registry: ReturnType<typeof createPaneRegistry> | undefined;
  const ready = (value: ReturnType<typeof createPaneRegistry>) => {
    registry = value;
  };
  const sessions = {
    describe: () => ({ themeName: "mocha" as const }),
    acquire: (target: { agentId: string }) =>
      Promise.resolve(
        target.agentId === "alpha"
          ? { ...alpha.session, address: "fixture://alpha/run" }
          : { ...beta.session, address: "fixture://beta/run" },
      ),
  };
  function Shell() {
    const dialog = useDialog();
    return (
      <QueryClientProvider client={app.queryClient}>
        <PaneWorkspace
          commandHost={app.commandHost}
          sessions={sessions}
          theme="mocha"
          exit={app.exit}
          openPane={() => undefined}
          dialog={dialog}
          onRegistry={ready}
        />
      </QueryClientProvider>
    );
  }
  try {
    await act(async () => {
      application.root.render(<Shell />);
      await setup.renderOnce();
    });
    if (registry === undefined) throw new Error("Registry did not mount");
    const panes = registry;
    await act(async () => {
      await panes.open({
        kind: "conversation",
        agentId: "alpha",
        sessionId: "one",
      });
      await panes.open({
        kind: "conversation",
        agentId: "beta",
        sessionId: "two",
      });
      for (const fixture of [alpha, beta]) {
        await fixture.session.command({
          type: "prompt",
          requestId: "active",
          delivery: "followUp",
          text: "Keep working",
        });
        fixture.confirmLatestPrompt();
      }
      await setup.waitForFrame((text) =>
        text.includes("Fixture is streaming a reply."),
      );
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEscape();
    });
    await waitForFrame(setup, (text: string) => text.includes("cancelling…"));
    expect(beta.cancelCalls()).toEqual([
      { type: "cancel", commandId: "owner-active" },
    ]);
    expect(beta.abortCalls()).toBe(0);
    expect(alpha.cancelCalls()).toEqual([]);
    expect(alpha.abortCalls()).toBe(0);
    const first = panes.read().find((pane) => !pane.focused);
    if (first === undefined) throw new Error("First pane missing");
    await act(async () => {
      panes.focus(first.paneId);
      await setup.renderOnce();
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("c", { ctrl: true });
    });
    await waitForFrame(setup, () => alpha.cancelCalls().length === 1);
    expect(alpha.cancelCalls()).toEqual([
      { type: "cancel", commandId: "owner-active" },
    ]);
    expect(alpha.abortCalls()).toBe(0);
    expect(beta.cancelCalls()).toEqual([
      { type: "cancel", commandId: "owner-active" },
    ]);
    expect(beta.abortCalls()).toBe(0);
    expect(application.destroyed()).toBe(false);
  } finally {
    await act(async () => {
      await application.close();
    });
  }
});

test("the native shell omits pane chrome and bounds visible notices and metadata", async () => {
  const commands = createWhistle();
  const { createAppSurfaceCommandHost } =
    await import("@fungi.computer/oyster/shell/command-host");
  const host = createAppSurfaceCommandHost(commands);
  const kits = new Map<string, import("../src/button/index.js").PaneKit>();
  let registry: ReturnType<typeof createPaneRegistry> | undefined;
  const ready = (value: ReturnType<typeof createPaneRegistry>) => {
    registry = value;
  };
  const kinds = [
    {
      kind: "display-fixture",
      instantiate: (target: import("../src/button/index.js").PaneTarget) => ({
        key: String(target.id),
        title: "Title\x1b[2J\x07\x9b",
        render: (kit: import("../src/button/index.js").PaneKit) => {
          kits.set(String(target.id), kit);
          kit.status.contribute({
            slot: "state",
            order: 0,
            text: "Status\x1b[2J",
            tone: "info",
          });
          return <text>Ready</text>;
        },
      }),
    },
  ];
  function Shell() {
    const dialog = useDialog();
    return (
      <PaneWorkspace
        commandHost={host}
        kinds={kinds}
        sessions={{ acquire: () => Promise.reject(new Error("No Session")) }}
        theme="mocha"
        exit={() => undefined}
        openPane={() => undefined}
        dialog={dialog}
        onRegistry={ready}
      />
    );
  }
  const setup = await testRender(<Shell />, { width: 80, height: 24 });
  try {
    if (registry === undefined) throw new Error("Registry missing");
    const panes = registry;
    await act(async () => {
      await panes.open({ kind: "display-fixture", id: "first" });
      await panes.open({ kind: "display-fixture", id: "second" });
      kits
        .get("second")
        ?.notify({ tone: "info", message: "Notice\x1b]0;unsafe\x07" });
    });
    await waitForFrame(setup, () =>
      setup.captureCharFrame().includes("Notice"),
    );
    const text = setup.captureCharFrame();
    expect(text.startsWith("Ready")).toBe(true);
    expect(text).not.toContain("Title");
    expect(text).not.toContain("Status");
    expect(panes.read().map((pane) => pane.title)).toEqual(["Title", "Title"]);
    expect(panes.read().map((pane) => pane.status[0]?.text)).toEqual([
      "Status",
      "Status",
    ]);
    expect(text).not.toContain("[2J");
    expect(text).toContain("Notice");
    expect(text).not.toContain("]0;unsafe");
    expect(text.replace(/\n/gu, "")).not.toMatch(/\p{Cc}/u);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    host.dispose();
    commands.close();
  }
});
