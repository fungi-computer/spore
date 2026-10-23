import { expect, test } from "bun:test";
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

const signedOut = "Sign in to Fungi and choose a Team to view its Apps";

test("typing / opens the command menu, including after a pane fails to open", async () => {
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const host = createAppSurfaceCommandHost(commands);
  const client = createQueryClient();
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
            return Promise.reject(new Error(signedOut));
          },
          requestGill: () => Promise.reject(new Error(signedOut)),
          openUi: () => Promise.reject(new Error(signedOut)),
        }}
      />
    </QueryClientProvider>,
    { width: 80, height: 24 },
  );
  const typeSlash = async () => {
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("/");
    });
    await waitForFrame(setup, (frame) => frame.includes("› /"));
  };
  const clearDraft = async () => {
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressBackspace();
    });
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
  };
  try {
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
    await typeSlash();
    await waitForFrame(setup, (frame) => frame.includes("/plan"));
    await clearDraft();

    // Signed out, the Apps choice fails; its reason must not leave the
    // conversation treating a modal as open.
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
    await waitForFrame(
      setup,
      (frame) => reads === 1 && !frame.includes("Open pane"),
    );
    // The reason is a toast, not a dialog: it never holds the keyboard, so the
    // slash menu opens under it, and Esc then dismisses the toast alone.
    await waitForFrame(setup, (frame) => frame.includes(signedOut));

    await typeSlash();
    await waitForFrame(setup, (frame) => frame.includes("/plan"));
    expect(setup.captureCharFrame()).toContain(signedOut);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEscape();
    });
    await waitForFrame(setup, (frame) => !frame.includes(signedOut));
    expect(setup.captureCharFrame()).toContain("/plan");
  } finally {
    await destroyTestRenderer(setup);
    host.dispose();
    client.clear();
  }
});
