import { waitForFrame } from "./native-readiness.js";
import { runningActivity } from "@fungi.computer/parakeet-testing";
import { expect, test } from "bun:test";
import { setTimeout as settle } from "node:timers/promises";
import {
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type Renderable,
} from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { act } from "react";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}

function mountedTimelineRows(root: Renderable): Renderable[] {
  return descendants(root).filter((node) =>
    node.id.startsWith("tui-timeline-row:"),
  );
}

function firstVisibleTimelineRow(
  root: Renderable,
  scroll: ScrollBoxRenderable,
): Renderable | undefined {
  const top = scroll.viewport.y;
  const bottom = top + scroll.viewport.height;
  return mountedTimelineRows(root).find(
    (row) => row.y + row.height > top && row.y < bottom,
  );
}

function durableMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `history-${String(index)}`,
    commandId: `history-command-${String(index)}`,
    sequence: index + 1,
    value: {
      role: "user" as const,
      content: `History ${String(index + 1)}`,
      timestamp: index + 1,
    },
  }));
}

test("long Session history scrolls continuously while older rows mount at the top", async () => {
  const fixture = createTuiFixture({ messages: durableMessages(601) });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={fixture.session}
        commands={createWhistle()}
        initialTheme="mocha"
      />
    </QueryClientProvider>,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => setup.renderOnce());
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("History 601")),
    );
    expect(setup.captureCharFrame()).toContain("History 601");
    expect(setup.captureCharFrame()).not.toContain("earlier entries");
    const initialNodes = descendants(setup.renderer.root).length;
    const initialRows = mountedTimelineRows(setup.renderer.root).length;
    expect(initialNodes).toBeLessThan(250);

    const scroll = descendants(setup.renderer.root).find(
      (node) => node instanceof ScrollBoxRenderable,
    );
    if (!(scroll instanceof ScrollBoxRenderable))
      throw new Error("Native timeline is unavailable");
    const bottom = scroll.scrollTop;

    act(() => {
      setup.mockInput.pressKey("\x1b[5~");
    });
    await act(async () => setup.renderOnce());
    expect(scroll.scrollTop).toBeLessThan(bottom);
    expect(mountedTimelineRows(setup.renderer.root).length).toBe(initialRows);

    await act(async () => {
      scroll.scrollTo(0);
      await setup.renderOnce();
    });
    const anchorBefore = firstVisibleTimelineRow(setup.renderer.root, scroll);
    expect(anchorBefore).toBeDefined();
    const anchorId = anchorBefore?.id;
    const anchorOffset = (anchorBefore?.y ?? 0) - scroll.viewport.y;
    await act(async () => {
      await setup.mockMouse.scroll(1, 1, "up");
      await setup.renderOnce();
    });
    await act(async () =>
      setup.waitFor(
        () => descendants(setup.renderer.root).length > initialNodes,
      ),
    );
    await act(async () => setup.waitFor(() => scroll.scrollTop > 0));
    const anchorAfter = descendants(setup.renderer.root).find(
      (node) => node.id === anchorId,
    );
    expect(anchorAfter).toBeDefined();
    expect((anchorAfter?.y ?? 0) - scroll.viewport.y).toBe(anchorOffset);

    for (let index = 0; index < 12; index += 1) {
      const mounted = mountedTimelineRows(setup.renderer.root);
      if (mounted.some((row) => row.id === "tui-timeline-row:history-0")) break;
      const firstId = mounted[0]?.id;
      await act(async () => {
        scroll.scrollTo(0);
        await setup.mockMouse.scroll(1, 1, "up");
        await setup.renderOnce();
      });
      await act(async () =>
        setup.waitFor(
          () => mountedTimelineRows(setup.renderer.root)[0]?.id !== firstId,
        ),
      );
      await act(async () => {
        await setup.renderOnce();
        await setup.renderOnce();
      });
    }
    expect(
      mountedTimelineRows(setup.renderer.root).some(
        (row) => row.id === "tui-timeline-row:history-0",
      ),
    ).toBe(true);
    expect(mountedTimelineRows(setup.renderer.root).length).toBeLessThanOrEqual(
      240,
    );

    for (let index = 0; index < 12; index += 1) {
      const mounted = mountedTimelineRows(setup.renderer.root);
      if (mounted.some((row) => row.id === "tui-timeline-row:history-600"))
        break;
      const lastId = mounted.at(-1)?.id;
      await act(async () => {
        scroll.scrollTo(scroll.scrollHeight);
        await setup.renderOnce();
      });
      await act(async () => {
        await setup.mockMouse.scroll(1, 10, "down");
        await setup.renderOnce();
      });
      await act(async () =>
        setup.waitFor(
          () => mountedTimelineRows(setup.renderer.root).at(-1)?.id !== lastId,
        ),
      );
      await act(async () => {
        await setup.renderOnce();
        await setup.renderOnce();
      });
    }

    await act(async () => {
      scroll.scrollTo(scroll.scrollHeight);
      await setup.renderOnce();
    });
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("History 601")),
    );
    expect(setup.captureCharFrame()).not.toContain("newer entries");
    expect(mountedTimelineRows(setup.renderer.root).length).toBeLessThanOrEqual(
      240,
    );

    act(() => {
      setup.mockInput.pressKey("\x1b[5~");
    });
    await act(async () => setup.renderOnce());
    const jump = descendants(setup.renderer.root).find(
      (node) =>
        node instanceof TextRenderable &&
        node.plainText.includes("Jump to latest"),
    );
    expect(jump).toBeDefined();
    if (jump !== undefined)
      await act(async () => {
        await setup.mockMouse.click(jump.x + 1, jump.y);
        await setup.renderOnce();
      });
    await act(async () =>
      setup.waitForFrame((frame) => !frame.includes("Jump to latest")),
    );
    expect(setup.captureCharFrame()).toContain("History 601");
    expect(setup.captureCharFrame()).not.toContain("Jump to latest");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    client.clear();
    await fixture.waitForClose();
  }
});

test("PageUp reveals an older page after its delayed read finishes", async () => {
  const fixture = createTuiFixture({ messages: durableMessages(220) });
  const snapshot = await fixture.session.read();
  const watch = fixture.session.watch;
  const page = (limit: number, before?: string) => {
    const end =
      before === undefined
        ? snapshot.messages.length
        : snapshot.messages.findIndex(
            (message) => `seq-${String(message.sequence)}` === before,
          );
    if (end < 0) throw new Error("Unknown history cursor");
    const start = Math.max(0, end - limit);
    const messages = snapshot.messages.slice(start, end);
    const oldest = messages[0];
    return {
      ...snapshot,
      messages,
      hasMore: start > 0,
      oldestCursor:
        start > 0 && oldest !== undefined
          ? `seq-${String(oldest.sequence)}`
          : null,
    };
  };
  const releaseRead = Promise.withResolvers<undefined>();
  let requested = false;
  const session: typeof fixture.session = {
    ...fixture.session,
    watch: async (options) => ({
      ...(await watch(options)),
      snapshot: page(Math.min(options?.limit ?? 200, 1)),
    }),
    read: async (options) => {
      if (options?.before !== undefined) {
        requested = true;
        await releaseRead.promise;
      }
      return page(options?.limit ?? 200, options?.before);
    },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame session={session} commands={commands} initialTheme="mocha" />
    </QueryClientProvider>,
    { width: 80, height: 24 },
  );
  const hasOlderRow = (frame: string) =>
    [...frame.matchAll(/History (\d+)/g)].some(
      ([, index]) => Number(index) < 220,
    );
  try {
    await act(async () => {
      await settle(0);
      await setup.renderOnce();
    });
    await waitForFrame(setup, (frame) => frame.includes("History 220"));
    const scroll = descendants(setup.renderer.root).find(
      (node) => node instanceof ScrollBoxRenderable,
    );
    if (!(scroll instanceof ScrollBoxRenderable))
      throw new Error("Native timeline is unavailable");
    expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.viewport.height);
    await act(async () => {
      setup.mockInput.pressKey("\x1b[5~");
      await setup.renderOnce();
      await setup.renderOnce();
    });
    expect(requested).toBe(true);
    expect(hasOlderRow(setup.captureCharFrame())).toBe(false);
    releaseRead.resolve(undefined);
    await act(async () => {
      await settle(0);
      await setup.renderOnce();
    });
    await waitForFrame(setup, hasOlderRow);
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
    expect(hasOlderRow(setup.captureCharFrame())).toBe(true);
    expect(setup.captureCharFrame()).toContain("Jump to latest");
  } finally {
    releaseRead.resolve(undefined);
    act(() => {
      setup.renderer.destroy();
    });
    client.clear();
    commands.close();
    await fixture.waitForClose();
  }
});

test("editing a multiline draft preserves manual scroll while progress grows", async () => {
  const fixture = createTuiFixture();
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
    { width: 80, height: 24 },
  );
  const progress = (lines: number) => ({
    messageId: "scroll-progress",
    revision: lines,
    text: Array.from(
      { length: lines },
      (_, index) => `Working line ${String(index + 1)}.`,
    ).join("\n\n"),
    thinking: "",
    textTruncated: false,
    thinkingTruncated: false,
  });
  try {
    await act(async () => setup.renderOnce());
    await act(async () => {
      fixture.pushFrame({
        kind: "progress",
        progress: progress(40),
        activity: runningActivity(),
      });
      await setup.waitForFrame((frame) => frame.includes("Working line"));
    });
    const scroll = descendants(setup.renderer.root).find(
      (node) => node instanceof ScrollBoxRenderable,
    );
    const editor = descendants(setup.renderer.root).find(
      (node) => node instanceof TextareaRenderable,
    );
    expect(scroll).toBeDefined();
    expect(editor).toBeDefined();
    if (!scroll || !editor) throw new Error("Native frame controls missing");
    expect(scroll.scrollTop).toBeGreaterThan(0);
    const bottom = scroll.scrollTop;
    await act(async () => {
      setup.mockInput.pressKey("\x1b[5~");
      await setup.renderOnce();
    });
    expect(scroll.scrollTop).toBeLessThan(bottom);
    const away = scroll.scrollTop;

    const draft =
      "Read the current owner.\nKeep the admitted work visible.\nReport the real gap.";
    await act(async () => setup.mockInput.pasteBracketedText(draft));
    await act(async () => setup.renderOnce());
    expect(editor.plainText).toBe(draft);
    expect(editor.height).toBeGreaterThan(1);
    expect(scroll.scrollTop).toBe(away);
    const previousContentHeight = scroll.scrollHeight;
    const projected = Promise.withResolvers<undefined>();
    const stopObserving = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success")
        projected.resolve(undefined);
    });
    try {
      await act(async () => {
        fixture.pushFrame({
          kind: "progress",
          progress: progress(45),
          activity: runningActivity(),
        });
        await projected.promise;
        // TanStack schedules observer notifications after the cache update.
        await settle(0);
      });
    } finally {
      stopObserving();
    }
    await act(async () => {
      await setup.waitFor(() => scroll.scrollHeight > previousContentHeight);
    });
    expect(scroll.scrollTop).toBe(away);
    expect(fixture.promptCalls()).toBe(0);
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.renderOnce();
    });
    await act(async () => setup.renderOnce());
    expect(fixture.promptCalls()).toBe(1);
    expect(editor.plainText).toBe("");
    expect(scroll.scrollTop).toBe(away);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    client.clear();
    await fixture.waitForClose();
    expect(fixture.closeCalls()).toBe(1);
  }
});
