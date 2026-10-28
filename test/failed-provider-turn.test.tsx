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
import { captureFrame } from "./frame-capture.js";

const privateText =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_redacted"}';

test("consecutive provider failures show one headline and reveal the latest raw response only through existing details", async () => {
  const fixture = createTuiFixture({
    messages: Array.from({ length: 7 }, (_, index) => ({
      id: `failed-turn-${String(index)}`,
      commandId: `failed-work-${String(index)}`,
      sequence: index + 1,
      value: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Details are actually open" }],
        api: "pi",
        provider: "anthropic",
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
        errorMessage:
          "Anthropic usage limit reached on your Claude subscription; resets at 16:00.",
        providerError: privateText,
        timestamp: index + 1,
      },
    })),
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
    { width: 80, height: 42 },
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
      setup.waitForFrame((frame) => frame.includes("Thinking")),
    );
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
    await captureFrame(
      setup,
      process.env.TUI_PROVIDER_ERRORS_CAPTURE_DIR,
      "errors-80x42",
    );
    const summary = setup.captureCharFrame();
    expect(summary).toContain("Anthropic usage limit reached");
    expect(summary).toContain("x7");
    expect(summary).not.toContain("req_redacted");
    expect(summary).not.toContain("rate_limit_error");
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
    expect(setup.captureCharFrame()).toContain("req_redacted");
    expect(setup.captureCharFrame().split("req_redacted")).toHaveLength(2);
    await captureFrame(
      setup,
      process.env.TUI_PROVIDER_ERRORS_CAPTURE_DIR,
      "errors-details-80x42",
    );
  } finally {
    keymap.cleanup();
    unregisterLeader();
    await destroyTestRenderer(setup);
    commands.close();
    query.clear();
    await fixture.waitForClose();
  }
});
