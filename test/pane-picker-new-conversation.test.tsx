import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createAppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

test("Open pane preselects New conversation so bare Enter starts one", async () => {
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const host = createAppSurfaceCommandHost(commands);
  const client = createQueryClient();
  let started = 0;
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        commandHost={host}
        openConversation={() => {
          started += 1;
          return Promise.resolve();
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
    await waitForFrame(setup, (frame) => frame.includes("New conversation"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, () => started === 1);
    expect(started).toBe(1);
  } finally {
    await destroyTestRenderer(setup);
    host.dispose();
    client.clear();
  }
});
