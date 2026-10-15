import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createAppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import { PaneWorkspace } from "../src/shell/workspace.js";
import { useDialog, type PaneSessionTarget } from "../src/button/index.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { createTuiFixture } from "./fixture.js";
import { waitForFrame } from "./native-readiness.js";

test("a retried /new after a transport failure admits one Session", async () => {
  const old = createTuiFixture({
    messages: [
      {
        id: "old-message",
        commandId: null,
        sequence: 1,
        value: { role: "user", content: "Previous conversation", timestamp: 1 },
      },
    ],
  });
  const fresh = createTuiFixture();
  // The Local owner's create ledger: one Session per create-request key. The
  // first attempt is admitted, then its reply is lost on the transport.
  const created = new Map<string, typeof fresh.session>();
  const keys: (string | undefined)[] = [];
  let failNextCreate = true;
  const owner = (target: PaneSessionTarget) => {
    if (target.sessionId !== null)
      return { ...old.session, address: "fixture://old" };
    const key =
      "createRequestId" in target ? target.createRequestId : undefined;
    keys.push(key);
    const ledgerKey = key ?? `unkeyed-${String(keys.length)}`;
    const session = created.get(ledgerKey) ?? {
      ...fresh.session,
      address: `fixture://fresh-${String(created.size + 1)}`,
    };
    created.set(ledgerKey, session);
    if (failNextCreate) {
      failNextCreate = false;
      throw new Error("Local service transport closed");
    }
    return session;
  };
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
            acquire: (target) => Promise.try(() => owner(target)),
          }}
        />
      </QueryClientProvider>
    );
  }
  const setup = await testRender(<Shell />, { width: 80, height: 24 });
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
    await act(async () => {
      await setup.mockInput.typeText("/new");
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, (frame) => frame.includes("Pane mount failed"));
    expect(setup.captureCharFrame()).toContain("Previous conversation");
    // The failed command stays in the composer; Enter retries the same intent.
    expect(setup.captureCharFrame()).toContain("› /new");
    act(() => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(
      setup,
      (frame) => keys.length === 2 && !frame.includes("Previous conversation"),
    );
    expect(keys[0]).toBeString();
    expect(keys[1]).toBe(keys[0]);
    expect(created.size).toBe(1);
    expect(panes.read()).toHaveLength(1);
    expect(panes.read()[0]?.paneId).toBe(paneId);
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
