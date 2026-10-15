import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createAppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import type { AppDirectory } from "@fungi.computer/oyster/shell/app-directory";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

const directory: AppDirectory = {
  actorIsTeamOwner: false,
  roles: {},
  apps: [
    {
      address: { kind: "default", appId: "app-ui" },
      appId: "app-ui",
      displayName: "Full UI App",
      installationId: null,
      surfaceId: "default:app-ui",
      releaseId: "release-ui",
      override: null,
      authorityVersion: 1,
      enforcement: null,
      grants: [],
      generationPermissions: { llm: false, media: false },
      marketplacePermissions: {
        browse: false,
        purchase: false,
        installFree: false,
      },
      agentPermission: {
        kind: "all-team-agents" as const,
        directoryOperations: [],
        sessionOperations: [],
      },
      handlers: [],
      roles: [],
      declaredCapabilities: [],
      commands: [],
      gills: [],
      availability: "available",
      surface: { stableRoute: "/ui" },
      surfacePath: "/apps/default/app-ui/ui",
    },
  ],
};

test("the shell App picker hands an App without Gills to its admitted full UI", async () => {
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const host = createAppSurfaceCommandHost(commands);
  const client = createQueryClient();
  const opened: string[] = [];
  let pending:
    ReturnType<typeof Promise.withResolvers<AppDirectory>> | undefined;
  let reads = 0;
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        commandHost={host}
        apps={{
          signedIn: () => Promise.resolve(true),
          read: () => {
            reads += 1;
            return pending?.promise ?? Promise.resolve(directory);
          },
          requestGill: () => Promise.reject(new Error("No Gill is declared")),
          openUi: (surfaceId) => {
            opened.push(surfaceId);
            return Promise.resolve();
          },
        }}
      />
    </QueryClientProvider>,
    { width: 80, height: 24 },
  );
  try {
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
    const open = host.active().palette.find((row) => row.title === "Open pane");
    if (open === undefined) throw new Error("Open pane command missing");
    await act(async () => {
      await host.execute(open.commandId, { origin: "programmatic" });
    });
    await waitForFrame(setup, (frame) => frame.includes("Open pane"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, (frame) => frame.includes("Full UI App"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, () => opened.length === 1);
    expect(opened).toEqual(["default:app-ui"]);
    expect(setup.captureCharFrame()).not.toContain("Gill");
    pending = Promise.withResolvers<AppDirectory>();
    await act(async () => {
      await host.execute(open.commandId, { origin: "programmatic" });
    });
    await waitForFrame(setup, (frame) => frame.includes("Open pane"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, () => reads === 2);
    const keys = host.active().bindings.find((row) => row.title === "Panes");
    if (keys === undefined) throw new Error("Panes command missing");
    await act(async () => {
      await host.execute(keys.commandId, { origin: "programmatic" });
    });
    await waitForFrame(setup, (frame) => frame.includes("All commands"));
    await act(async () => {
      pending?.resolve(directory);
      await setup.renderOnce();
    });
    // Decode another real key after the directory completion, then inspect the
    // active dialog rather than the previous frame still waiting to repaint.
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    expect(setup.captureCharFrame()).toContain("All commands");
    expect(setup.captureCharFrame()).not.toContain("Full UI App");
    expect(opened).toHaveLength(1);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    host.dispose();
    client.clear();
  }
});

test("Open pane lists the launchers registered kinds declare", async () => {
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const host = createAppSurfaceCommandHost(commands);
  const client = createQueryClient();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        commandHost={host}
      />
    </QueryClientProvider>,
    { width: 80, height: 24 },
  );
  try {
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
    const open = host.active().palette.find((row) => row.title === "Open pane");
    if (open === undefined) throw new Error("Open pane command missing");
    await act(async () => {
      await host.execute(open.commandId, { origin: "programmatic" });
    });
    await waitForFrame(setup, (frame) => frame.includes("Open pane"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Local terminal");
    expect(frame).not.toContain("Apps");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    host.dispose();
    client.clear();
  }
});
