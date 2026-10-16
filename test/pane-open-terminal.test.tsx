import { expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createAppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import { useDialog, type PaneKindEntry } from "../src/button/index.js";
import { conversationPane } from "../src/panes/conversation/index.js";
import { PaneWorkspace } from "../src/shell/workspace.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

/**
 * The unit twins of the pre-install smoke check: the one Open pane picker
 * leads with a working terminal, a failed pane never holds the keyboard, and only the
 * focused pane receives typed keys.
 */
const signedOut = "Sign in to Fungi and choose a Team to view its Apps";

async function frameFor(
  node: ReactNode,
  host: ReturnType<typeof createAppSurfaceCommandHost>,
) {
  const client = createQueryClient();
  const setup = await testRender(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    { width: 120, height: 30 },
  );
  /** PTY output arrives after render idle; poll real frames. */
  const shows = async (check: (text: string) => boolean) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      await act(async () => {
        await setup.renderOnce();
      });
      if (check(setup.captureCharFrame())) return;
      await Bun.sleep(10);
    }
    throw new Error(`Frame never matched:\n${setup.captureCharFrame()}`);
  };
  const run = async (title: string) => {
    const row = host.active().palette.find((entry) => entry.title === title);
    if (row === undefined) throw new Error(`${title} command missing`);
    await act(async () => {
      await host.execute(row.commandId, { origin: "programmatic" });
    });
  };
  const type = async (text: string) => {
    await act(async () => {
      await setup.mockInput.typeText(text);
      setup.mockInput.pressEnter();
    });
  };
  const close = () => {
    act(() => {
      setup.renderer.destroy();
    });
    host.dispose();
    client.clear();
  };
  const terminalReady = () =>
    host.active().palette.some((row) => row.title === "Send Ctrl K to shell");
  return { setup, shows, run, type, close, terminalReady };
}

function frame(apps?: Parameters<typeof TuiFrame>[0]["apps"]) {
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const host = createAppSurfaceCommandHost(commands);
  return {
    host,
    node: (
      <TuiFrame
        session={fixture.session}
        commands={commands}
        commandHost={host}
        apps={apps}
      />
    ),
  };
}

test("Open pane lists the Local terminal first; Enter opens a shell that takes typed input", async () => {
  const { host, node } = frame();
  const view = await frameFor(node, host);
  try {
    await view.shows((text) => text.includes("Ask anything"));
    await view.run("Open pane");
    await view.shows((text) => text.includes("▶ Local terminal"));
    await pressDecodedKey(view.setup, () => {
      view.setup.mockInput.pressEnter();
    });
    await view.shows(view.terminalReady);
    expect(view.setup.captureCharFrame()).not.toContain("Local machine");
    expect(view.setup.captureCharFrame()).not.toContain("Open pane");
    await view.shows((text) => text.includes("$"));
    await view.type("echo typed-$((40+2))");
    await view.shows((text) => text.includes("typed-42"));
    expect(view.setup.captureCharFrame()).not.toContain("› echo");
  } finally {
    view.close();
  }
}, 30_000);

test("signed out, Open pane lists only choices that work", async () => {
  const unused = () => Promise.reject(new Error("Apps are not offered"));
  const { host, node } = frame({
    signedIn: () => Promise.resolve(false),
    read: unused,
    requestGill: unused,
    openUi: unused,
  });
  const view = await frameFor(node, host);
  try {
    await view.shows((text) => text.includes("Ask anything"));
    await view.run("Open pane");
    await view.shows((text) => text.includes("Local terminal"));
    expect(view.setup.captureCharFrame()).not.toContain("Apps");
    await pressDecodedKey(view.setup, () => {
      view.setup.mockInput.pressEnter();
    });
    await view.shows(view.terminalReady);
    await view.type("echo signed-out-$((3+3))");
    await view.shows((text) => text.includes("signed-out-6"));
  } finally {
    view.close();
  }
}, 30_000);

test("an App choice that fails reports a notice and the terminal still takes input", async () => {
  const reject = () => Promise.reject(new Error(signedOut));
  const { host, node } = frame({
    signedIn: () => Promise.resolve(true),
    read: reject,
    requestGill: reject,
    openUi: reject,
  });
  const view = await frameFor(node, host);
  try {
    await view.shows((text) => text.includes("Ask anything"));
    await view.run("Open pane");
    await view.shows((text) => text.includes("Apps"));
    // Local terminal is first; Apps follows it.
    await pressDecodedKey(view.setup, () => {
      view.setup.mockInput.pressArrow("down");
    });
    await pressDecodedKey(view.setup, () => {
      view.setup.mockInput.pressEnter();
    });
    await view.shows((text) => text.includes(signedOut));
    await view.run("Open pane");
    await view.shows((text) => text.includes("▶ Local terminal"));
    await pressDecodedKey(view.setup, () => {
      view.setup.mockInput.pressEnter();
    });
    await view.shows(view.terminalReady);
    await view.type("echo after-$((1+1))");
    await view.shows((text) => text.includes("after-2"));
    expect(view.setup.captureCharFrame()).not.toContain(signedOut);
  } finally {
    view.close();
  }
}, 30_000);

test("an unfocused conversation does not take keys typed into another pane", async () => {
  const fixture = createTuiFixture();
  const host = createAppSurfaceCommandHost();
  const received: string[] = [];
  const quiet: PaneKindEntry = {
    kind: "quiet",
    instantiate: () => ({
      key: "quiet",
      title: "Quiet",
      render: (kit) => {
        kit.input.onKey((event) => {
          received.push(event.name);
          return false;
        });
        return <text>quiet pane</text>;
      },
    }),
  };
  let registry: ReturnType<typeof createPaneRegistry> | undefined;
  let dialogs: ReturnType<typeof useDialog> | undefined;
  // Stable across renders: a new callback would retire the workspace.
  const onRegistry = (value: ReturnType<typeof createPaneRegistry>) => {
    registry = value;
  };
  const sessions = {
    describe: () => ({ agentName: "Shiitake", themeName: "mocha" as const }),
    acquire: () => Promise.resolve(fixture.session),
  };
  const kinds = [conversationPane, quiet];
  function Shell() {
    const dialog = useDialog();
    dialogs = dialog;
    return (
      <PaneWorkspace
        kinds={kinds}
        commandHost={host}
        theme="mocha"
        exit={() => undefined}
        openPane={() => undefined}
        dialog={dialog}
        onRegistry={onRegistry}
        sessions={sessions}
      />
    );
  }
  const view = await frameFor(<Shell />, host);
  try {
    if (registry === undefined) throw new Error("Registry missing");
    const panes = registry;
    await act(async () => {
      await panes.open({
        kind: "conversation",
        agentId: "agent-fixture",
        sessionId: "main",
      });
    });
    await waitForFrame(view.setup, (text) => text.includes("Ask anything"));
    // The live path: a picker opened over the conversation closes after the
    // chosen pane takes focus, and hands native focus back to the composer.
    const picker = dialogs?.show(() => <text>picker</text>);
    await waitForFrame(view.setup, (text) => text.includes("picker"));
    await act(async () => {
      await panes.open({ kind: "quiet" });
    });
    act(() => {
      picker?.dismiss();
    });
    await waitForFrame(
      view.setup,
      (text) => text.includes("quiet pane") && !text.includes("picker"),
    );
    await pressDecodedKey(view.setup, () => {
      view.setup.mockInput.pressKey("q");
    });
    await view.shows(() => received.includes("q"));
    expect(view.setup.captureCharFrame()).toContain("Ask anything");
    expect(view.setup.captureCharFrame()).not.toContain("› q");
  } finally {
    await act(async () => {
      await registry?.dispose();
    });
    view.close();
  }
}, 30_000);
