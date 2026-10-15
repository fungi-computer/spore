import { idleActivity } from "@fungi.computer/parakeet-testing";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import {
  createWhistle,
  createWhistleKeymapAdapter,
  type WhistleKeymapHost,
} from "@fungi.computer/whistle";
import type { SessionSnapshot } from "@fungi.computer/shiitake/client";
import { act } from "react";
import { TuiFrame } from "../src/frame.js";
import { createDesignTuiFixture } from "./design-fixture.js";
import { captureFrame } from "./frame-capture.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * One compaction boundary: two pre-compaction turns, a marker, then two
 * post-compaction turns. The client shows all four turns plus the divider;
 * only the model's own run-scope context is bounded by the marker.
 */
const compactionDividerDesignSnapshot: SessionSnapshot = {
  pending: { total: 0, prompts: [], hasMore: false },
  sessionId: "tui-design-compaction",
  cursor: "design-cursor-compaction",
  hasMore: false,
  oldestCursor: null,
  messages: [
    {
      id: "old-question",
      commandId: "old-question",
      sequence: 1,
      value: {
        role: "user",
        content: "Summarize the codebase layout for me.",
        timestamp: 1,
      },
    },
    {
      id: "old-answer",
      commandId: null,
      sequence: 2,
      value: {
        role: "assistant",
        api: "pi",
        provider: "camel",
        model: "auto",
        content: [
          {
            type: "text",
            text: "It is a pnpm workspace with apps and packages.",
          },
        ],
        stopReason: "stop",
        timestamp: 2,
        usage: zeroUsage,
      },
    },
    {
      id: "recent-question",
      commandId: "recent-question",
      sequence: 3,
      value: {
        role: "user",
        content: "Now add a divider above the kept context.",
        timestamp: 3,
      },
    },
    {
      id: "recent-answer",
      commandId: null,
      sequence: 4,
      value: {
        role: "assistant",
        api: "pi",
        provider: "camel",
        model: "auto",
        content: [{ type: "text", text: "Done — the divider renders above." }],
        stopReason: "stop",
        timestamp: 4,
        usage: zeroUsage,
      },
    },
  ],
  terminals: [],
  compactions: [
    {
      id: "design-compaction-1",
      sequence: 3,
      at: 3,
      tokensBefore: 120_000,
      tokensAfter: 30_000,
      trigger: "threshold",
    },
  ],
  activity: idleActivity,
  progress: null,
  extensions: {},
  attention: [],
};

async function mount(snapshot: SessionSnapshot, width = 100) {
  const fixture = createDesignTuiFixture({ snapshot });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        initialTheme="mocha"
      />
    </QueryClientProvider>,
    { width, height: 40 },
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
    } satisfies WhistleKeymapHost,
    commands,
    "keyboard",
  );
  await act(async () => setup.renderOnce());
  return {
    setup,
    dispose: () => {
      keymap.cleanup();
      act(() => {
        setup.renderer.destroy();
      });
      client.clear();
      commands.close();
    },
  };
}

test("renders a full-width dim rule stating the compaction's result in plain words", async () => {
  const { setup, dispose } = await mount(compactionDividerDesignSnapshot);
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("compacted 120K")),
    );
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    const dividerIndex = lines.findIndex((line) =>
      line.includes("compacted 120K"),
    );
    expect(dividerIndex).toBeGreaterThan(0);

    const dividerLine = lines[dividerIndex] ?? "";
    // Plain words for the result, not a generic boundary label.
    expect(dividerLine).toContain("compacted 120K → 30K");
    expect(dividerLine).toContain("─");

    // Full history is visible: both the pre- and post-compaction turns show.
    expect(frame).toContain("Summarize the codebase layout for me.");
    expect(frame).toContain("It is a pnpm workspace with apps and packages.");
    expect(frame).toContain("Now add a divider above the kept context.");
    expect(frame).toContain("Done — the divider renders above.");

    // A blank line above and below the rule.
    expect((lines[dividerIndex - 1] ?? "placeholder").trim()).toBe("");
    expect((lines[dividerIndex + 1] ?? "placeholder").trim()).toBe("");

    // The pre-compaction turn renders above the divider; the kept turn below.
    const oldAnswerIndex = lines.findIndex((line) =>
      line.includes("It is a pnpm workspace with apps and packages."),
    );
    const recentQuestionIndex = lines.findIndex((line) =>
      line.includes("Now add a divider above the kept context."),
    );
    expect(oldAnswerIndex).toBeLessThan(dividerIndex);
    expect(recentQuestionIndex).toBeGreaterThan(dividerIndex);
  } finally {
    dispose();
  }
});

test("falls back to the boundary label for an older marker with no tokensAfter", async () => {
  const olderMarkerSnapshot: SessionSnapshot = {
    ...compactionDividerDesignSnapshot,
    compactions: [
      {
        id: "design-compaction-older",
        sequence: 3,
        at: 3,
        tokensBefore: 120_000,
        tokensAfter: null,
        trigger: null,
      },
    ],
  };
  const { setup, dispose } = await mount(olderMarkerSnapshot);
  try {
    await act(async () =>
      setup.waitForFrame((frame) =>
        frame.includes("the agent's memory starts below"),
      ),
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("compacted · the agent's memory starts below");
    expect(frame).not.toContain("→");
  } finally {
    dispose();
  }
});

test("shows a failed compaction as a short notice at its own place in the timeline", async () => {
  const noticeSnapshot: SessionSnapshot = {
    ...compactionDividerDesignSnapshot,
    compactions: [],
    compactionNotices: [
      {
        id: "design-notice-1",
        sequence: 3,
        at: 3,
        trigger: "threshold",
        result: "failed",
        diagnostic: "Compaction failed (model: timeout)",
      },
    ],
  };
  const { setup, dispose } = await mount(noticeSnapshot);
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("compaction failed")),
    );
    await captureFrame(
      setup,
      process.env.TUI_CONTEXT_FOOTER_CAPTURE_DIR,
      "compaction-capture-notice-failed",
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("compaction failed");
    expect(frame).toContain("Compaction failed (model: timeout)");
  } finally {
    dispose();
  }
});

test("shows a manual compaction with nothing to compact as a short notice", async () => {
  const noticeSnapshot: SessionSnapshot = {
    ...compactionDividerDesignSnapshot,
    compactions: [],
    compactionNotices: [
      {
        id: "design-notice-2",
        sequence: 3,
        at: 3,
        trigger: "manual",
        result: "nothing_to_compact",
        diagnostic: null,
      },
    ],
  };
  const { setup, dispose } = await mount(noticeSnapshot);
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("nothing to compact")),
    );
    await captureFrame(
      setup,
      process.env.TUI_CONTEXT_FOOTER_CAPTURE_DIR,
      "compaction-capture-notice-nothing-to-compact",
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("nothing to compact");
  } finally {
    dispose();
  }
});
