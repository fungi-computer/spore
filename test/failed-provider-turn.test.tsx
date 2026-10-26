import { expect, test } from "bun:test";
import { act } from "react";
import { registerLeader } from "@opentui/keymap/addons";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  createWhistle,
  createWhistleKeymapAdapter,
  type WhistleKeymapHost,
} from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";

const privateText = "provider_error: 401 Bearer sk-live-fake-secret";

test("a failed turn shows provider prose exactly once even with details open", async () => {
  const fixture = createTuiFixture({
    messages: [
      {
        id: "failed-turn",
        commandId: "failed-work",
        sequence: 1,
        value: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Details are actually open" },
          ],
          api: "pi",
          provider: "faux",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "error",
          errorMessage: "Safe model failure",
          providerError: privateText,
          timestamp: 1,
        },
      },
    ],
  });
  const query = createQueryClient();
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        initialTheme="mocha"
      />
    </QueryClientProvider>,
    { width: 100, height: 30 },
  );
  const nativeKeymap = createDefaultOpenTuiKeymap(setup.renderer);
  const unregisterLeader = registerLeader(nativeKeymap, { trigger: "ctrl+k" });
  const keymap = createWhistleKeymapAdapter(
    {
      registerLayer: (layer) =>
        nativeKeymap.registerLayer({
          ...layer,
          target: setup.renderer.root,
          priority: 100,
        }),
    } satisfies WhistleKeymapHost,
    commands,
    "keyboard",
  );
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes(privateText)),
    );
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame().split(privateText)).toHaveLength(2);
    expect(setup.captureCharFrame()).not.toContain("Details are actually open");
    await act(async () => {
      setup.mockInput.pressKey("o", { ctrl: true });
      await setup.renderOnce();
      await setup.renderOnce();
    });
    await act(async () =>
      setup.waitForFrame((frame) =>
        frame.includes("Details are actually open"),
      ),
    );
    expect(setup.captureCharFrame()).toContain("Details are actually open");
    expect(setup.captureCharFrame().split(privateText)).toHaveLength(2);
    expect(setup.captureCharFrame()).not.toContain("Safe model failure");
  } finally {
    keymap.cleanup();
    unregisterLeader();
    await destroyTestRenderer(setup);
    commands.close();
    query.clear();
    await fixture.waitForClose();
  }
});
