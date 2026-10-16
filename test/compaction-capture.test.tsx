// Real-engine proof that the footer shows "compacting" live while a manual
// /compact commit is in flight, that it carries a real tokens/window figure
// throughout (including right after the commit, from the fixed
// estimateThresholdContextTokens), and that the transcript's divider states
// a real reduction in plain words. A compaction handoff extension blocks the
// commit's own window open so the test can capture the frame while it is
// live, the same technique shiitake's own "blocked-handoff" law uses.
import { expect, test } from "bun:test";
import { act } from "react";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fauxModelSource, memoryHost } from "@fungi.computer/shiitake/testing";
import {
  defineExtension,
  ExtensionId,
} from "@fungi.computer/shiitake/extensions";
import { TuiFrame } from "../src/frame.js";
import { captureFrame } from "./frame-capture.js";
import { footerRow } from "./footer-row.js";

const contextWindow = 200_000;
// Pi never drops a reply away from the question it answered: if one old
// reply's own size alone already exceeds keepRecentTokens, the cut lands on
// that reply and keeps it whole (a "split turn", with only its prompt
// prefix-summarized). A single giant old turn would so stay kept in full --
// no real reduction. Many *individually modest* old turns avoid that: each
// one fits under the budget alone, so the cut lands cleanly once their sum
// crosses it, and only a small, bounded tail survives.
const oldTurns = 10;
const oldReplyChars = 12_000; // ≈ 3_000 tokens each; ≈ 30_000 tokens together.
const keepRecentTokens = 4_000;

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}

test("the footer shows compacting live with a real window, then the divider's plain-words reduction", async () => {
  let releaseHandoff: (() => void) | undefined;
  const handoff = new Promise<void>((resolve) => {
    releaseHandoff = resolve;
  });
  const extension = defineExtension({
    id: ExtensionId.make("compaction-capture-handoff"),
    version: "1.0.0",
  }).define({
    compaction: () => ({
      consume: () =>
        handoff.then(() => ({ type: "discarded_by_policy" as const })),
    }),
  });

  const sessionId = "compaction-capture";
  // `fauxModelSource` starts a fresh scripted reply list on every acquire,
  // so each model call here needs its own reply source, selected in
  // order -- otherwise every call replays the first reply, including the
  // compaction's own summarization call, and nothing actually shrinks.
  // Many equal-sized old turns land the cut mid-turn (a "split turn", in
  // Pi's own terms): the compaction then makes both a history summary and
  // a turn-prefix summary call, so its source carries two replies.
  const replies = [
    ...Array.from({ length: oldTurns }, () =>
      fauxModelSource([fauxAssistantMessage("x".repeat(oldReplyChars))]),
    ),
    fauxModelSource([fauxAssistantMessage("Good catch, fixed.")]),
    fauxModelSource([
      fauxAssistantMessage("history summary"),
      fauxAssistantMessage("turn prefix summary"),
    ]),
  ];
  let calls = 0;
  const host = await memoryHost({
    extensions: [extension],
    compaction: { keepRecentTokens },
    model: {
      acquire: (input) => {
        const reply = replies[Math.min(calls, replies.length - 1)];
        calls += 1;
        if (reply === undefined) throw new Error("No scripted reply");
        return reply.acquire(input);
      },
      describe: () => Promise.resolve({ contextWindow }),
    },
  });
  const session = host.agent.session(sessionId);
  const query = createQueryClient();
  const commands = createWhistle();
  const output = process.env.TUI_CONTEXT_FOOTER_CAPTURE_DIR;
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame session={session} commands={commands} initialTheme="mocha" />
    </QueryClientProvider>,
    { width: 100, height: 24 },
  );
  try {
    for (let turn = 0; turn < oldTurns; turn += 1) {
      await session.send(`Build history turn ${String(turn)}.`, {
        requestId: `capture-history-${String(turn)}`,
      });
      await host.settle(sessionId);
    }
    await session.send("One more short thing to check.", {
      requestId: "capture-history-recent",
    });
    const settledBefore = await host.settle(sessionId);
    expect(settledBefore.activity.queue.state).toBe("idle");
    // Host settlement is not acknowledgement by the streamed Query/React
    // projection. Observe its idle footer before capturing, just as we observe
    // the later compacting state; one render can still show "queued for host".
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await setup.renderOnce();
      });
      if (footerRow(setup.captureCharFrame(), "idle") !== undefined) break;
    }
    await captureFrame(setup, output, "compaction-capture-idle");
    const idleFrame = setup.captureCharFrame();
    const idleRow = footerRow(idleFrame, "idle");
    expect(idleRow).toBeDefined();
    // A real described window shows "<tokens>/200K", not tokens alone,
    // and ten ~3_000-token turns put the idle figure near 30K.
    expect(idleRow).toContain("/200K");
    expect(idleRow).toMatch(/\b(2[5-9]|3[0-5])K\/200K/u);

    await session.command({ type: "compact", requestId: "capture-compact" });
    const running = host.reconcile();
    let sawCompacting = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await setup.renderOnce();
      });
      if (footerRow(setup.captureCharFrame(), "compacting") !== undefined) {
        sawCompacting = true;
        break;
      }
    }
    expect(sawCompacting).toBe(true);
    await captureFrame(setup, output, "compaction-capture-compacting");
    expect(footerRow(setup.captureCharFrame(), "compacting")).toContain(
      "/200K",
    );

    releaseHandoff?.();
    await running;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await setup.renderOnce();
      });
      if (footerRow(setup.captureCharFrame(), "compacting") === undefined)
        break;
    }
    const settled = await session.read();
    const marker = settled.compactions?.at(-1);
    expect(marker?.trigger).toBe("manual");
    if (marker === undefined) throw new Error("No compaction marker");
    // tokensBefore is the whole pre-compaction context (every old turn
    // plus the kept one), not just what survives -- it must match the
    // idle figure just captured, not the small kept tail.
    expect(marker.tokensBefore).toBeGreaterThan(25_000);
    // The kept tail is bounded by keepRecentTokens plus at most one
    // modest extra message, nowhere near tokensBefore: a real reduction.
    expect(marker.tokensAfter).toBeGreaterThan(0);
    expect(marker.tokensAfter).toBeLessThan(keepRecentTokens * 2);
    expect(marker.tokensAfter).toBeLessThan(marker.tokensBefore / 4);

    // Scroll up until the divider mounts and is visible, so the after
    // capture shows the transcript's plain-words result, not just the
    // footer. The kept tail is bounded by design, so a handful of pages
    // up reaches it.
    const scroll = descendants(setup.renderer.root).find(
      (node) => node instanceof ScrollBoxRenderable,
    );
    if (!(scroll instanceof ScrollBoxRenderable))
      throw new Error("Native timeline is unavailable");
    let sawDivider = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (setup.captureCharFrame().includes("compacted ")) {
        sawDivider = true;
        break;
      }
      act(() => {
        setup.mockInput.pressKey("\x1b[5~");
      });
      await act(async () => setup.renderOnce());
    }
    expect(sawDivider).toBe(true);
    await captureFrame(setup, output, "compaction-capture-compacted");
    const dividerFrame = setup.captureCharFrame();
    expect(dividerFrame).toContain("compacted ");
    expect(dividerFrame).toContain("→");
    // The divider's own numbers must show the same real reduction.
    expect(dividerFrame).toMatch(/compacted (2[5-9]|3[0-5])K → [0-9]K/u);

    act(() => {
      scroll.scrollTo(Number.MAX_SAFE_INTEGER);
    });
    await act(async () => setup.renderOnce());
    const footerFrame = setup.captureCharFrame();
    expect(footerRow(footerFrame, "compacting")).toBeUndefined();
    const idleAfter = footerRow(footerFrame, "idle");
    expect(idleAfter).toBeDefined();
    // The live figure now follows the fixed estimator: the real
    // post-compaction context, dropped to match the divider's "after",
    // never the wrong "0" and never missing the window.
    expect(idleAfter).toContain("/200K");
    expect(idleAfter).not.toMatch(/·\s*0(\/|$)/u);
    expect(idleAfter).not.toMatch(/\b(2[5-9]|3[0-5])K\/200K/u);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    query.clear();
    commands.close();
    await host.close();
  }
}, 30_000);
