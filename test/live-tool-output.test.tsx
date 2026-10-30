import { expect, test } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import {
  createDesignTuiFixture,
  runningToolsDesignSnapshot,
} from "./design-fixture.js";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { setTimeout as delay } from "node:timers/promises";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { waitForFrame } from "./native-readiness.js";

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}

test("a folded native call shows six live lines and opens the whole tail without restyling the row", async () => {
  const snapshot = {
    ...runningToolsDesignSnapshot,
    toolOutput: [
      {
        toolCallId: "group-typecheck",
        revision: 1,
        droppedBytes: 2048,
        totalBytes: 4096,
        tail: "step one\nstep two\nstep three\nstep four\nstep five\nstep six\nstep seven\nstep eight\n",
      },
    ],
  };
  const fixture = createDesignTuiFixture({ snapshot });
  const commands = createWhistle();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        initialTheme="mocha"
      />
    </QueryClientProvider>,
    { width: 100, height: 48 },
  );
  try {
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("Running pnpm"));
    });
    const folded = setup.captureCharFrame();
    expect(folded).toContain("step eight");
    expect(folded).toContain("step three");
    expect(folded).not.toContain("step one");
    expect(folded).not.toContain("step two");
    expect(folded).not.toContain("… 2 KiB earlier");
    const y = folded
      .split("\n")
      .findLastIndex((line) => line.includes("Running pnpm"));
    await act(async () => {
      await setup.mockMouse.click(15, y);
      await delay(20);
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("step one");
    expect(setup.captureCharFrame()).toContain("… 2 KiB earlier");
  } finally {
    await destroyTestRenderer(setup);
    client.clear();
    commands.close();
  }
  await fixture.waitForClose();
});

test("a full folded tail keeps its height at the bottom and does not move a scrolled-up reader", async () => {
  const slot = (revision: number, count: number, droppedBytes = 0) => ({
    toolCallId: "group-typecheck",
    revision,
    droppedBytes,
    totalBytes: droppedBytes + 4096,
    tail: Array.from(
      { length: count },
      (_, index) => `live line ${String(index + 1)} ${"wide".repeat(20)}`,
    ).join("\n"),
  });
  const snapshot = {
    ...runningToolsDesignSnapshot,
    messages: runningToolsDesignSnapshot.messages.map((message) =>
      message.value.role === "user"
        ? {
            ...message,
            value: {
              ...message.value,
              content: Array.from(
                { length: 40 },
                (_, index) => `Earlier line ${String(index)}`,
              ).join("\n\n"),
            },
          }
        : message,
    ),
    toolOutput: [slot(1, 8)],
  };
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
    { width: 80, height: 24 },
  );
  const update = async (revision: number, count: number, droppedBytes = 0) => {
    const projected = Promise.withResolvers<undefined>();
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success")
        projected.resolve(undefined);
    });
    try {
      await act(async () => {
        fixture.pushFrame({
          kind: "tool_output",
          activity: snapshot.activity,
          toolOutput: [slot(revision, count, droppedBytes)],
        });
        await projected.promise;
        await delay(20);
        await setup.renderOnce();
      });
    } finally {
      unsubscribe();
    }
  };
  try {
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("live line 8"));
    });
    const scroll = descendants(setup.renderer.root).find(
      (node) => node instanceof ScrollBoxRenderable,
    );
    if (!(scroll instanceof ScrollBoxRenderable))
      throw new Error("Transcript scroller missing");
    const height = scroll.scrollHeight;
    const bottom = scroll.scrollTop;
    expect(bottom).toBeGreaterThan(0);
    await update(2, 30, 2048);
    expect(setup.captureCharFrame()).toContain("live line 30");
    expect(scroll.scrollHeight).toBe(height);
    expect(scroll.scrollTop).toBe(bottom);
    await act(async () => {
      setup.mockInput.pressKey("\x1b[5~");
      await setup.renderOnce();
    });
    await waitForFrame(setup, (frame) => frame.includes("Jump to latest"));
    expect(scroll.scrollTop).toBeLessThan(bottom);
    const away = scroll.scrollTop;
    const visibleHistory = () =>
      setup
        .captureCharFrame()
        .split("\n")
        .flatMap((line, row) => {
          const text = /Earlier line \d+/u.exec(line)?.[0];
          return text === undefined ? [] : [{ row, text }];
        });
    const history = visibleHistory();
    await update(3, 60, 4096);
    expect(scroll.scrollTop).toBe(away);
    expect(visibleHistory()).toEqual(history);
  } finally {
    await destroyTestRenderer(setup);
    client.clear();
    commands.close();
  }
  await fixture.waitForClose();
});
