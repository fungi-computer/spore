import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import type { GillResponse } from "@fungi.computer/gills";
import { openTerminalApplication } from "../src/terminal-application.js";
import { PaneWorkspace } from "../src/shell/workspace.js";
import { useDialog, type PaneApps } from "../src/button/index.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";
import { captureFrame } from "./frame-capture.js";

const hostileText =
  "TAGA\x1b]52;c;SGVsbG8=\x07B\x1b]0;pwn\x07C\x9b2JD\u202eE\u2060F\x1b[31mG\x85H";
const safeText = "TAGABCDEFGH";

const page: GillResponse = {
  viewId: "inbox",
  title: "Inbox",
  state: "full",
  rows: [
    {
      id: "row-one",
      title: "Permission-filtered conversation",
      detail: "Needs you",
      tone: "attention",
      open: {
        params: [
          { key: "agent", value: "agent-visible" },
          { key: "session", value: "session-one" },
        ],
      },
    },
  ],
};

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  test(`Gill navigation replaces its pane and retire late work (${String(width)}x${String(height)})`, async () => {
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
    const app = application;
    app.inputHandoff?.pause();
    const fixture = createTuiFixture();
    const other = createTuiFixture();
    let initialRead:
      ReturnType<typeof Promise.withResolvers<GillResponse>> | undefined =
      Promise.withResolvers<GillResponse>();
    let registry: ReturnType<typeof createPaneRegistry> | undefined;
    let handoffs = 0;
    let reads = 0;
    let failRead = false;
    let readFailure = "Fixture read failed";
    let currentPage: GillResponse = page;
    let delayed:
      ReturnType<typeof Promise.withResolvers<GillResponse>> | undefined;
    let readSignal: AbortSignal | undefined;
    const apps: PaneApps = {
      signedIn: () => Promise.resolve(true),
      read: () =>
        Promise.reject(new Error("Directory is tested at the Local door")),
      requestGill: async (surfaceId, input, signal) => {
        expect(surfaceId).toBe("grove");
        expect(input).toEqual({ viewId: "inbox" });
        reads += 1;
        readSignal = signal;
        if (initialRead !== undefined) return initialRead.promise;
        if (delayed !== undefined) return delayed.promise;
        if (failRead) throw new Error(readFailure);
        return currentPage;
      },
      openUi: () => {
        handoffs += 1;
        return Promise.resolve();
      },
    };
    function Shell() {
      const dialog = useDialog();
      return (
        <QueryClientProvider client={app.queryClient}>
          <PaneWorkspace
            commandHost={app.commandHost}
            sessions={{
              describe: () => ({
                themeName: "mocha",
                agentName: "Garden helper",
              }),
              acquire: (target) => {
                expect(target.agentId).toBe("agent-visible");
                if (target.sessionId === "session-two")
                  return Promise.resolve({
                    ...other.session,
                    address: "fixture://other/session-two",
                  });
                expect(target.sessionId).toBe("session-one");
                return Promise.resolve(fixture.session);
              },
            }}
            apps={apps}
            theme="mocha"
            exit={app.exit}
            openPane={() => undefined}
            dialog={dialog}
            onRegistry={(value) => {
              registry = value;
            }}
          />
        </QueryClientProvider>
      );
    }
    const key = (name: Parameters<typeof setup.mockInput.pressKey>[0]) =>
      pressDecodedKey(setup, () => {
        setup.mockInput.pressKey(name);
      });
    try {
      await act(async () => {
        application.root.render(<Shell />);
        await setup.renderOnce();
      });
      if (registry === undefined) throw new Error("Registry did not mount");
      const panes = registry;
      await act(async () => {
        await panes.open({ kind: "gill", surfaceId: "grove", viewId: "inbox" });
      });
      await waitForFrame(setup, (frame) => frame.includes("Loading…"));
      act(() => {
        initialRead?.resolve(page);
        initialRead = undefined;
      });
      await waitForFrame(setup, (frame) =>
        frame.includes("Permission-filtered conversation"),
      );
      expect(setup.captureCharFrame()).not.toContain("agent-hidden");
      expect(panes.read()[0]?.title).toBe("Inbox");
      const inboxPaneId = panes.read()[0]?.paneId;
      expect(setup.captureCharFrame()).not.toContain("Gill");
      await captureFrame(
        setup,
        process.env.PANE_CAPTURE_DIR,
        `inbox-${String(width)}x${String(height)}`,
      );
      await key("o");
      expect(handoffs).toBe(1);
      const readsBeforeOpen = reads;
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
      expect(reads).toBe(readsBeforeOpen);
      expect(
        panes.read().find((pane) => pane.title === page.rows[0]?.title),
      ).toBeDefined();
      expect(setup.captureCharFrame()).not.toContain("session-one");
      expect(setup.captureCharFrame()).not.toContain("agent-visible");
      expect(panes.read()).toHaveLength(1);
      expect(panes.read()[0]?.paneId).toBe(inboxPaneId);
      await captureFrame(
        setup,
        process.env.PANE_CAPTURE_DIR,
        `inbox-conversation-${String(width)}x${String(height)}`,
      );
      // Only an explicit pane command creates another Inbox pane.
      await act(async () => {
        await panes.open({ kind: "gill", surfaceId: "grove", viewId: "inbox" });
      });
      await waitForFrame(setup, (frame) =>
        frame.includes("Permission-filtered conversation"),
      );
      expect(panes.read()).toHaveLength(2);
      const gill = panes.read().find((pane) => pane.title === "Inbox");
      if (gill === undefined) throw new Error("Gill pane missing");
      act(() => {
        panes.focus(gill.paneId);
      });
      await waitForFrame(setup, () => reads >= 2);
      failRead = true;
      await key("r");
      await waitForFrame(setup, (frame) =>
        frame.includes("Fixture read failed"),
      );
      failRead = false;
      await key("r");
      await waitForFrame(
        setup,
        (frame) => !frame.includes("Fixture read failed"),
      );
      const assertSafe = () => {
        const frame = setup.captureCharFrame();
        for (const control of [
          "\x1b",
          "\x07",
          "\x9b",
          "\x85",
          "\u202e",
          "\u2060",
        ])
          expect(frame).not.toContain(control);
      };
      currentPage = {
        ...page,
        rows: page.rows.map((row) => ({
          ...row,
          title: `Title ${hostileText}`,
          detail: `Detail ${hostileText}`,
        })),
      };
      await key("r");
      await waitForFrame(
        setup,
        (frame) =>
          frame.includes(`Title ${safeText}`) &&
          frame.includes(`Detail ${safeText}`),
      );
      assertSafe();
      currentPage = {
        viewId: "inbox",
        title: "Inbox",
        state: "error",
        rows: [],
        error: `Error ${hostileText}`,
      };
      await key("r");
      await waitForFrame(setup, (frame) => frame.includes(`Error ${safeText}`));
      assertSafe();
      readFailure = `Failure ${hostileText}`;
      failRead = true;
      await key("r");
      await waitForFrame(setup, (frame) =>
        frame.includes(`Failure ${safeText}`),
      );
      assertSafe();
      failRead = false;
      readFailure = "Fixture read failed";
      currentPage = {
        viewId: "inbox",
        title: "Inbox",
        state: "empty",
        rows: [],
      };
      await key("r");
      await waitForFrame(setup, (frame) => frame.includes("No items yet"));
      currentPage = {
        viewId: "inbox",
        title: "Inbox",
        state: "error",
        rows: [],
        error: "Unavailable",
        reason: "exec_isolation_required",
      };
      await key("r");
      await waitForFrame(setup, (frame) =>
        frame.includes("isn't available here"),
      );
      const permanentReads = reads;
      await key("r");
      expect(reads).toBe(permanentReads);
      expect(setup.captureCharFrame()).not.toContain("R refresh");
      currentPage = page;
      await act(async () => {
        await panes.open({
          kind: "conversation",
          agentId: "agent-visible",
          sessionId: "session-two",
          title: "   ",
        });
      });
      const peer = panes.read().find((pane) => pane.focused);
      if (peer === undefined) throw new Error("Conversation peer missing");
      expect(peer.title).toBe("Garden helper · New conversation");
      expect(setup.captureCharFrame()).not.toContain("session-two");
      act(() => {
        panes.focus(peer.paneId);
      });
      act(() => {
        panes.focus(gill.paneId);
      });
      await waitForFrame(
        setup,
        (frame) => !frame.includes("isn't available here"),
      );
      // Gill reads belong to their focused pane, not to the Session lifetime.
      delayed = Promise.withResolvers<GillResponse>();
      const readsBeforeBlur = reads;
      await key("r");
      await waitForFrame(setup, () => reads === readsBeforeBlur + 1);
      const blurReadSignal = readSignal;
      expect(blurReadSignal?.aborted).toBe(false);
      act(() => {
        panes.focus(peer.paneId);
      });
      expect(blurReadSignal?.aborted).toBe(true);
      await act(async () => {
        delayed?.resolve({ ...page, title: "Retired focus result" });
        await setup.renderOnce();
      });
      expect(panes.read().find((pane) => pane.focused)?.paneId).toBe(
        peer.paneId,
      );
      expect(
        panes.read().find((pane) => pane.paneId === gill.paneId)?.title,
      ).toBe("Inbox");
      expect(panes.read()).toHaveLength(3);
      delayed = undefined;
      const readsBeforeRefocus = reads;
      act(() => {
        panes.focus(gill.paneId);
      });
      await waitForFrame(
        setup,
        (frame) =>
          reads > readsBeforeRefocus &&
          frame.includes("Permission-filtered conversation"),
      );
      delayed = Promise.withResolvers<GillResponse>();
      const readsBeforeClose = reads;
      await key("r");
      await waitForFrame(setup, () => reads === readsBeforeClose + 1);
      const closeReadSignal = readSignal;
      expect(closeReadSignal?.aborted).toBe(false);
      await act(async () => {
        await panes.close(gill.paneId);
      });
      expect(closeReadSignal?.aborted).toBe(true);
      await act(async () => {
        delayed?.resolve({ ...page, title: "Retired close result" });
        await setup.renderOnce();
      });
      await waitForFrame(setup, (frame) => !frame.includes("Inbox"));
      expect(panes.read().some((pane) => pane.paneId === gill.paneId)).toBe(
        false,
      );
      expect(
        panes.read().some((pane) => pane.title === "Retired close result"),
      ).toBe(false);
      expect(panes.read()).toHaveLength(2);
      expect(fixture.abortCalls()).toBe(0);
      expect(fixture.cancelCalls()).toEqual([]);
    } finally {
      application.exit();
    }
  });
}
