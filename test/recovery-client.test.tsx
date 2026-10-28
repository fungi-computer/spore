import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWhistle,
  createWhistleKeymapAdapter,
} from "@fungi.computer/whistle";
import type { SessionFrame } from "@fungi.computer/shiitake/client";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

test("Esc collapses recovery, leaves the draft editable, Ctrl+B reopens and Ctrl+C quits", async () => {
  const fixture = createTuiFixture();
  const lost = Promise.withResolvers<IteratorResult<SessionFrame>>();
  let opened = false;
  let exited = false;
  const session = {
    ...fixture.session,
    watch: async () => {
      const watch = await fixture.session.watch();
      opened = true;
      return {
        ...watch,
        changes: {
          [Symbol.asyncIterator]: () => ({ next: () => lost.promise }),
        },
      };
    },
  };
  const client = new QueryClient();
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={session}
        commands={commands}
        initialTheme="mocha"
        onRebindService={() =>
          Promise.resolve({ kind: "unavailable", alive: true })
        }
        onExit={() => {
          exited = true;
        }}
      />
    </QueryClientProvider>,
    { width: 100, height: 30 },
  );
  const nativeKeymap = createDefaultOpenTuiKeymap(setup.renderer);
  const keymap = createWhistleKeymapAdapter(
    {
      registerLayer: (layer) =>
        nativeKeymap.registerLayer({
          ...layer,
          target: setup.renderer.root,
          priority: 100,
        }),
    },
    commands,
    "keyboard",
  );
  try {
    await waitForFrame(
      setup,
      (frame) => opened && frame.includes("Ask anything"),
    );
    act(() => {
      lost.reject(new Error("Lost watch"));
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Your conversation will resume"),
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEscape();
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Ctrl+B shows details"),
    );
    expect(setup.captureCharFrame()).not.toContain(
      "Your conversation will resume",
    );
    await act(async () => {
      await setup.mockInput.typeText("Still editing");
    });
    await waitForFrame(setup, (frame) => frame.includes("Still editing"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("RETURN");
    });
    await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Still editing") && frame.includes("Ask anything"),
    );
    await act(async () => {
      await setup.mockInput.typeText("Keep this second draft");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("RETURN");
    });
    const fullQueue = await waitForFrame(setup, (frame) =>
      frame.includes(
        "One prompt is already queued; it sends when the service is back.",
      ),
    );
    expect(fullQueue).toContain("Still editing");
    expect(fullQueue).toContain("Keep this second draft");
    expect(fixture.promptCalls()).toBe(0);
    expect(fixture.abortCalls()).toBe(0);
    expect(fixture.cancelCalls()).toEqual([]);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("b", { ctrl: true });
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Your conversation will resume"),
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("c", { ctrl: true });
    });
    expect(exited).toBe(true);
  } finally {
    keymap.cleanup();
    await destroyTestRenderer(setup);
    client.clear();
    commands.close();
  }
});
