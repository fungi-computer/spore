import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { openLocalTeamApps } from "@fungi.computer/truffle/apps";
import { openTerminalApplication } from "../src/terminal-application.js";
import { PaneWorkspace } from "../src/shell/workspace.js";
import {
  useDialog,
  sigilGutterText,
  type PaneSession,
  type PaneApps,
} from "../src/button/index.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";
import { captureFrame } from "./frame-capture.js";

const idleStatus = `${sigilGutterText("●")}idle`;

const proxy = process.env.S4_ADMITTED_ORIGIN;
const credentialPath = process.env.S4_CREDENTIAL_PATH;
if (proxy === undefined || credentialPath === undefined)
  throw new Error("Run through the Hub admitted-inbox-gill fixture");
const transport: typeof globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const original = new Request(input, init);
    const source = new URL(original.url);
    const request = new Request(
      new URL(`${source.pathname}${source.search}`, proxy),
      original,
    );
    return fetch(request);
  },
  { preconnect: globalThis.fetch.preconnect },
);
const local = await openLocalTeamApps({ credentialPath, fetch: transport });
const directory = await local.read();
const grove = directory.apps.find((app) =>
  app.gills.some((gill) => gill.id === "inbox"),
);
if (grove === undefined)
  throw new Error("Published Inbox missing from the admitted directory");
const output = process.env.PANE_CAPTURE_DIR;
if (output !== undefined) await mkdir(output, { recursive: true });

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
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
  let registry: ReturnType<typeof createPaneRegistry> | undefined;
  let handoffs = 0;
  let watches = 0;
  const leases = new Map<PaneSession, () => Promise<void>>();
  const closeFailures: unknown[] = [];
  const apps: PaneApps = {
    signedIn: () => Promise.resolve(true),
    read: (signal) => local.read(signal),
    requestGill: (surfaceId, request, signal) =>
      local.requestGill(surfaceId, request, signal),
    openUi: async (surfaceId, signal) => {
      const url = await local.surfaceUrl(surfaceId, signal);
      assert.equal(url.origin, directoryOrigin());
      assert.equal(url.pathname, grove.surfacePath);
      assert.equal(url.searchParams.get("releaseId"), grove.releaseId);
      handoffs += 1;
    },
  };
  function directoryOrigin() {
    return new URL(directoryUrl()).origin;
  }
  function directoryUrl() {
    return "https://gill-local.example.test";
  }
  function Shell() {
    const dialog = useDialog();
    return (
      <QueryClientProvider client={app.queryClient}>
        <PaneWorkspace
          commandHost={app.commandHost}
          apps={apps}
          sessions={{
            describe: () => ({ themeName: "mocha" }),
            acquire: async (target, signal) => {
              if (target.sessionId === null)
                throw new Error("Proof opens an existing Session");
              const acquired = await local.openSession(
                { agentId: target.agentId, sessionId: target.sessionId },
                signal,
              );
              const session: PaneSession = {
                ...acquired.session,
                watch: async (options) => {
                  const observation = await acquired.session.watch(options);
                  watches += 1;
                  return observation;
                },
              };
              leases.set(session, acquired.close);
              signal.addEventListener(
                "abort",
                () => {
                  void acquired
                    .close()
                    .catch((cause: unknown) => closeFailures.push(cause));
                },
                { once: true },
              );
              return session;
            },
          }}
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
  try {
    await act(async () => {
      app.root.render(<Shell />);
      await setup.renderOnce();
    });
    if (registry === undefined) throw new Error("Registry did not mount");
    const panes = registry;
    await act(async () => {
      await panes.open({
        kind: "gill",
        surfaceId: grove.surfaceId,
        viewId: "inbox",
      });
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("agent-visible conversation"),
    );
    assert.ok(!setup.captureCharFrame().includes("agent-hidden"));
    assert.equal(panes.read().length, 1);
    const inboxPane = panes.read()[0];
    assert.ok(inboxPane);
    assert.equal(inboxPane.title, "Inbox");
    await captureFrame(
      setup,
      output,
      `inbox-${String(width)}x${String(height)}`,
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("o");
    });
    await waitForFrame(setup, () => handoffs === 1);
    assert.equal(handoffs, 1);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, () =>
      panes.read().some((pane) => pane.title === "agent-visible conversation"),
    );
    assert.equal(panes.read().length, 1);
    const conversationPane = panes.read()[0];
    assert.ok(conversationPane);
    assert.equal(conversationPane.paneId, inboxPane.paneId);
    assert.equal(conversationPane.title, "agent-visible conversation");
    assert.equal(conversationPane.focused, true);
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
    await waitForFrame(setup, () => watches === 1);
    await waitForFrame(setup, (frame) => frame.includes(idleStatus));
    assert.ok(!setup.captureCharFrame().includes("session_"));
    assert.ok(!setup.captureCharFrame().includes("Gill"));
    await captureFrame(
      setup,
      output,
      `inbox-conversation-${String(width)}x${String(height)}`,
    );
  } finally {
    app.exit();
    for (const close of leases.values()) await close();
    assert.deepEqual(closeFailures, []);
  }
}
console.log(
  "PASS admitted Inbox → native Gill → visit → ordinary remote conversation at 80x24 and 160x48",
);
