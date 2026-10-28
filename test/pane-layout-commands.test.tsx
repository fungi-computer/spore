import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { createAppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import { PaneWorkspace } from "../src/shell/workspace.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { useDialog } from "../src/button/index.js";
import { probePane } from "./fixtures/probe-pane/probe-pane.js";
import { openTerminalApplication } from "../src/terminal-application.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

test("named layout commands reach Maosaico through the real shell command host", async () => {
  const whistle = createWhistle();
  const host = createAppSurfaceCommandHost(whistle);
  let registry: ReturnType<typeof createPaneRegistry> | undefined;
  const ready = (value: ReturnType<typeof createPaneRegistry>) => {
    registry = value;
  };
  function Shell() {
    const dialog = useDialog();
    return (
      <PaneWorkspace
        commandHost={host}
        kinds={[probePane]}
        sessions={{ acquire: () => Promise.reject(new Error("No Session")) }}
        theme="mocha"
        exit={() => undefined}
        openPane={() => undefined}
        dialog={dialog}
        onRegistry={ready}
      />
    );
  }
  const setup = await testRender(<Shell />, { width: 160, height: 48 });
  try {
    if (registry === undefined) throw new Error("Registry missing");
    const panes = registry;
    await act(async () => {
      for (const label of ["alpha", "beta", "gamma", "delta"])
        await panes.open({ kind: "probe", label });
    });
    await act(async () => {
      const outcome = await host.execute(
        { namespace: "shell", id: "layout-grid" },
        {
          origin: "palette",
        },
      );
      expect(outcome.status).toBe("handled");
    });
    expect(panes.read().map((pane) => pane.frame)).toEqual([
      { x: 0, y: 0, width: 80, height: 24 },
      { x: 80, y: 0, width: 80, height: 24 },
      { x: 0, y: 24, width: 80, height: 24 },
      { x: 80, y: 24, width: 80, height: 24 },
    ]);
    for (const [layout, expected] of [
      ["main-left", { x: 0, y: 0, width: 80, height: 48 }],
      ["main-top", { x: 0, y: 0, width: 160, height: 24 }],
      ["columns", { x: 0, y: 0, width: 40, height: 48 }],
      ["rows", { x: 0, y: 0, width: 160, height: 12 }],
      ["grid", { x: 0, y: 0, width: 80, height: 24 }],
    ] as const) {
      await act(async () => {
        const outcome = await host.execute(
          { namespace: "shell", id: `layout-${layout}` },
          {
            origin: "palette",
          },
        );
        expect(outcome.status).toBe("handled");
      });
      expect(panes.read()[0]?.frame).toEqual(expected);
    }
    const ids = host.active().palette.map((row) => row.commandId);
    expect(ids).not.toContain("shell:pane-split-x");
    expect(ids).not.toContain("shell:pane-split-y");
  } finally {
    await act(async () => {
      await registry?.dispose();
      setup.renderer.destroy();
    });
    host.dispose();
    whistle.close();
  }
});

test("native layout and resize keys preserve panes and live input", async () => {
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
  let registry: ReturnType<typeof createPaneRegistry> | undefined;
  const ready = (value: ReturnType<typeof createPaneRegistry>) => {
    registry = value;
  };
  function Shell() {
    const dialog = useDialog();
    return (
      <PaneWorkspace
        commandHost={app.commandHost}
        kinds={[probePane]}
        sessions={{ acquire: () => Promise.reject(new Error("No Session")) }}
        theme="mocha"
        exit={app.exit}
        openPane={() => undefined}
        dialog={dialog}
        onRegistry={ready}
      />
    );
  }
  try {
    await act(async () => {
      app.root.render(<Shell />);
      await setup.renderOnce();
    });
    if (registry === undefined) throw new Error("Registry missing");
    const panes = registry;
    await act(async () => {
      for (const label of ["alpha", "beta", "gamma", "delta"])
        await panes.open({ kind: "probe", label });
    });
    const identities = panes.read().map((pane) => pane.paneId);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("q");
    });
    for (const expected of [
      { x: 0, y: 0, width: 160, height: 24 },
      { x: 0, y: 0, width: 40, height: 48 },
      { x: 0, y: 0, width: 160, height: 12 },
      { x: 0, y: 0, width: 80, height: 24 },
      { x: 0, y: 0, width: 80, height: 48 },
    ]) {
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("k", { ctrl: true });
      });
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey(" ");
      });
      // Rendering is the observable completion boundary, not a timer.
      await waitForFrame(setup, () => {
        const frame = panes.read()[0]?.frame;
        return (
          frame?.width === expected.width && frame.height === expected.height
        );
      });
      expect(panes.read()[0]?.frame).toEqual(expected);
      expect(panes.read().map((pane) => pane.paneId)).toEqual(identities);
      expect(setup.captureCharFrame()).toContain("keys:q");
    }
    for (const [key, width] of [
      [">", 84],
      ["<", 80],
      [">", 84],
      ["=", 80],
    ] as const) {
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("k", { ctrl: true });
      });
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey(key);
      });
      await waitForFrame(setup, () => panes.read()[0]?.frame.width === width);
      expect(panes.read()[0]?.frame.width).toBe(width);
      expect(panes.read().map((pane) => pane.paneId)).toEqual(identities);
      expect(setup.captureCharFrame()).toContain("keys:q");
    }
    act(() => {
      setup.resize(200, 48);
    });
    await waitForFrame(setup, () => panes.read()[0]?.frame.width === 100);
    expect(panes.read()[0]?.frame.width).toBe(100);
    await act(async () => {
      const outcome = await app.commandHost.execute(
        { namespace: "shell", id: "layout-main-top" },
        {
          origin: "palette",
        },
      );
      expect(outcome.status).toBe("handled");
    });
    for (const [key, height] of [
      [">", 28],
      ["<", 24],
      [">", 28],
      ["=", 24],
    ] as const) {
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("k", { ctrl: true });
      });
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey(key);
      });
      await waitForFrame(setup, () => panes.read()[0]?.frame.height === height);
      expect(panes.read()[0]?.frame.height).toBe(height);
    }
    act(() => {
      setup.resize(200, 64);
    });
    await waitForFrame(setup, () => panes.read()[0]?.frame.height === 32);
    expect(panes.read()[0]?.frame.height).toBe(32);
  } finally {
    await act(async () => {
      await app.close();
    });
  }
});
