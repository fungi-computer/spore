import { expect, test } from "bun:test";
import { RGBA, type KeyEvent } from "@opentui/core";
import { terminalPalette } from "@fungi.computer/stipe";
import { Shiitake, type ShiitakeAgent } from "@fungi.computer/shiitake";
import { testRender } from "@opentui/react/test-utils";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  createWhistle,
  createWhistleKeymapAdapter,
  type WhistleKeymapHost,
} from "@fungi.computer/whistle";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { act, createElement } from "react";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  compatibilityRunDependencies,
  createCompatibilityRuntimeHost,
  createNativeSqliteOwnerFixture,
} from "../../../packages/shiitake/test/fixtures/native-sqlite-owner.fixture.js";
import { TuiFrame } from "../src/frame.js";
import { rendererInteraction } from "../src/renderer-interaction.js";
import type { Setup } from "./frame-capture.js";
import { captureFrame } from "./frame-capture.js";

/** Await the terminal parser's real Esc event before observing its consequence. */
async function pressEsc(setup: Setup) {
  const decoded = Promise.withResolvers<undefined>();
  const onKey = (event: KeyEvent) => {
    if (event.name === "escape") decoded.resolve(undefined);
  };
  setup.renderer.keyInput.prependListener("keypress", onKey);
  const timer = setTimeout(() => {
    decoded.reject(new Error("Esc was not decoded"));
  }, 2_000);
  try {
    await act(async () => {
      setup.mockInput.pressEscape();
      await decoded.promise;
    });
  } finally {
    clearTimeout(timer);
    setup.renderer.keyInput.off("keypress", onKey);
  }
}

async function queuedFrame(
  agent: ShiitakeAgent,
  sessionId: string,
  name: string,
  inspect?: (setup: Setup) => void | Promise<void>,
  width = process.env.TUI_QUEUE_WIDTH === "160" ? 160 : 80,
) {
  const client = createQueryClient();
  const commands = createWhistle();
  notifyManager.setScheduler(queueMicrotask);
  const setup = await testRender(
    createElement(QueryClientProvider, {
      client,
      children: createElement(TuiFrame, {
        session: agent.session(sessionId),
        commands,
        initialTheme: "mocha",
      }),
    }),
    { width, height: width === 160 ? 48 : 24, ...rendererInteraction },
  );
  const nativeKeymap = createDefaultOpenTuiKeymap(setup.renderer);
  const keymap = createWhistleKeymapAdapter(
    {
      registerLayer: (layer) =>
        nativeKeymap.registerLayer({
          bindings: layer.bindings,
          commands: layer.commands,
          target: setup.renderer.root,
          priority: 100,
        }),
    } satisfies WhistleKeymapHost,
    commands,
    "keyboard",
  );
  try {
    await act(async () => setup.renderOnce());
    await act(async () =>
      setup.waitForFrame(
        (frame) => frame.includes("●") && !frame.includes("● connecting"),
      ),
    );
    await captureFrame(setup, process.env.TUI_QUEUE_SHOTS, name);
    await inspect?.(setup);
    return setup.captureCharFrame();
  } finally {
    keymap.cleanup();
    act(() => {
      setup.renderer.destroy();
    });
    commands.close();
    client.clear();
    notifyManager.setScheduler(defaultScheduler);
  }
}

test("one conversation awaits its host without claiming another conversation blocks it", async () => {
  const fixture = createNativeSqliteOwnerFixture();
  const runtime = createCompatibilityRuntimeHost();
  const agent = await Shiitake.make({
    ...compatibilityRunDependencies(),
    store: fixture.owner,
    runtime: runtime.runtime,
  });
  try {
    const session = agent.session("only-conversation");
    const accepted = await session.send("Reply once.", {
      delivery: "followUp",
      requestId: "reply",
    });
    expect(
      fixture.owner.sql.exec("SELECT count(*) AS count FROM sessions").one()
        .count,
    ).toBe(1);
    expect(
      fixture.owner.sql
        .exec(
          "SELECT count(*) AS count FROM watchdog_jobs WHERE state='running'",
        )
        .one().count,
    ).toBe(0);
    const frame = await queuedFrame(
      agent,
      "only-conversation",
      `awaiting-host-${process.env.TUI_QUEUE_WIDTH ?? "80"}`,
    );
    expect(frame).toContain("queued for host");
    expect(frame.split("Reply once.")).toHaveLength(2);
    expect(frame).toContain("queued");
    expect(frame).not.toContain("PgUp/PgDn scroll");
    expect(frame).not.toContain("another conversation");
    expect((await session.read()).activity.queue).toEqual({
      state: "queued",
      commandId: accepted.commandId,
      runningWork: null,
    });
    await runtime.runNext();
    expect((await session.read()).terminals).toMatchObject([
      { outcome: "completed" },
    ]);
  } finally {
    await agent.close();
    fixture.close();
  }
});

test("a queued conversation identifies the actual Session holding the Agent", async () => {
  const fixture = createNativeSqliteOwnerFixture();
  const runtime = createCompatibilityRuntimeHost();
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const faux = fauxProvider();
  faux.setResponses([
    async () => {
      started.resolve(undefined);
      await release.promise;
      return fauxAssistantMessage("First reply");
    },
    fauxAssistantMessage("Second reply"),
  ]);
  const agent = await Shiitake.make({
    ...compatibilityRunDependencies(),
    store: fixture.owner,
    runtime: runtime.runtime,
    model: {
      acquire: () =>
        Promise.resolve({
          model: faux.getModel(),
          stream: faux.provider.streamSimple.bind(faux.provider),
          release: () => Promise.resolve(),
        }),
    },
  });
  let running: Promise<void> | undefined;
  try {
    const first = await agent
      .session("conversation-a")
      .send("First", { delivery: "followUp", requestId: "first" });
    running = runtime.runNext();
    await started.promise;
    const second = agent.session("conversation-b");
    const accepted = await second.send("Second", {
      delivery: "followUp",
      requestId: "second",
    });
    const frame = await queuedFrame(
      agent,
      "conversation-b",
      `session-blocker-${process.env.TUI_QUEUE_WIDTH ?? "80"}`,
    );
    expect(frame).toContain("waiting for Session conversation-a");
    expect(frame.split("Second")).toHaveLength(2);
    expect(frame).toContain("queued");
    expect(frame).not.toContain("PgUp/PgDn scroll");
    expect((await second.read()).activity.queue).toEqual({
      state: "queued",
      commandId: accepted.commandId,
      runningWork: {
        kind: "session",
        sessionId: "conversation-a",
        commandId: first.commandId,
      },
    });
  } finally {
    release.resolve(undefined);
    await running;
    await agent.close();
    fixture.close();
  }
});

test("shows queued prompts once as dimmed scrollable messages without Esc withdrawing work", async () => {
  const fixture = createNativeSqliteOwnerFixture();
  const runtime = createCompatibilityRuntimeHost();
  const agent = await Shiitake.make({
    ...compatibilityRunDependencies(),
    store: fixture.owner,
    runtime: runtime.runtime,
  });
  const session = agent.session("queue-preview");
  try {
    for (const [index, text] of [
      "\u001b]52;c;Y21k\u0007\u001b]0;spoof\u0007\u001b]8;;https://evil.test\u001b\\First task\u001b]8;;\u001b\\\u001b[2J\u009b2J\u202e\u2060",
      "Second task",
      "Third task",
      "Fourth task",
    ].entries())
      await session.send(text, {
        delivery: "followUp",
        requestId: `preview-${String(index)}`,
      });
    await queuedFrame(
      agent,
      "queue-preview",
      `queue-four-${process.env.TUI_QUEUE_WIDTH ?? "80"}`,
      async (setup) => {
        const frame = setup.captureCharFrame();
        expect(frame).not.toContain("4 queued messages");
        expect(frame).not.toContain("+1 more");
        expect(
          setup
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .some(
              (span) =>
                span.text.trim() === "queued" && (span.attributes & 2) === 2,
            ),
        ).toBe(true);
        expect(frame.split("Second task")).toHaveLength(2);
        expect(frame).not.toContain("PgUp/PgDn scroll");
        expect(frame).toContain("First task");
        expect(frame).toContain("Second task");
        expect(frame).toContain("Third task");
        expect(frame).toContain("Fourth task");
        const queued = setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes("Second task"));
        expect(queued).toBeDefined();
        expect((queued?.attributes ?? 0) & 2).toBe(2);
        const palette = terminalPalette("mocha");
        if (palette === undefined) throw new Error("Mocha palette is missing");
        const normalForeground = RGBA.fromHex(palette.foreground)
          .toInts()
          .slice(0, 3);
        expect(queued?.fg.toInts().slice(0, 3)).not.toEqual(normalForeground);
        for (const [index, channel] of normalForeground.entries())
          expect(queued?.fg.toInts()[index]).toBeLessThan(channel);
        const marker = setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.trim() === "queued");
        expect(marker?.fg.toInts().slice(0, 3)).toEqual(
          queued?.fg.toInts().slice(0, 3),
        );
        for (const control of [
          "\u001b",
          "\u0007",
          "\u009b",
          "\u202e",
          "\u2060",
        ])
          expect(frame).not.toContain(control);
        await pressEsc(setup);
        expect((await session.read()).pending.total).toBe(4);
      },
    );
  } finally {
    await agent.close();
    fixture.close();
  }
});

test("Esc stops only the current run and the next queued message runs", async () => {
  const fixture = createNativeSqliteOwnerFixture();
  const runtime = createCompatibilityRuntimeHost();
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const nextStarted = Promise.withResolvers<undefined>();
  const releaseNext = Promise.withResolvers<undefined>();
  const faux = fauxProvider();
  faux.setResponses([
    async () => {
      started.resolve(undefined);
      await release.promise;
      return fauxAssistantMessage("Finished");
    },
    async () => {
      nextStarted.resolve(undefined);
      await releaseNext.promise;
      return fauxAssistantMessage("Next completed");
    },
    fauxAssistantMessage("Another completed"),
    fauxAssistantMessage("Last completed"),
  ]);
  const agent = await Shiitake.make({
    ...compatibilityRunDependencies(),
    store: fixture.owner,
    runtime: runtime.runtime,
    model: {
      acquire: () =>
        Promise.resolve({
          model: faux.getModel(),
          stream: faux.provider.streamSimple.bind(faux.provider),
          release: () => Promise.resolve(),
        }),
    },
  });
  let running: Promise<unknown> | undefined;
  try {
    const session = agent.session("active-with-queue");
    await session.send("Active task", {
      delivery: "followUp",
      requestId: "active",
    });
    running = runtime.runNext();
    await started.promise;
    for (const [index, text] of [
      "Next task",
      "Another task",
      "Last task",
    ].entries()) {
      await session.send(text, {
        delivery: "followUp",
        requestId: `next-${String(index)}`,
      });
    }
    const frame = await queuedFrame(
      agent,
      "active-with-queue",
      `running-three-${process.env.TUI_QUEUE_WIDTH ?? "80"}`,
      async (setup) => {
        await pressEsc(setup);
        await setup.waitFor(
          async () =>
            (await session.read()).activity.cancellationRequested ||
            (await session.read()).terminals.some(
              (terminal) => terminal.outcome === "cancelled",
            ),
        );
        expect(
          (await session.read()).pending.prompts.map((prompt) => prompt.text),
        ).toEqual(["Next task", "Another task", "Last task"]);
      },
    );
    expect(frame).not.toContain("3 queued messages");
    expect(frame).toContain("queued");
    expect(frame).toContain("Active task");
    expect(frame).not.toContain("PgUp/PgDn scroll");
    expect(frame).toContain("Next task");
    expect(frame).toContain("Another task");
    expect(frame).toContain("Last task");
    expect(frame).not.toContain("waiting for Session");
    release.resolve(undefined);
    await running;
    running = undefined;
    running = runtime.runNext();
    await nextStarted.promise;
    const next = await session.read();
    expect(next.activity.queue.state).toBe("running");
    const startedFrame = await queuedFrame(
      agent,
      "active-with-queue",
      `next-started-${process.env.TUI_QUEUE_WIDTH ?? "80"}`,
      (setup) => {
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Next task");
        const running = setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes("Next task"));
        expect((running?.attributes ?? 0) & 1).toBe(1);
        expect((running?.attributes ?? 0) & 2).toBe(0);
        expect(frame.split("Another task")).toHaveLength(2);
        expect(frame).toContain("queued");
      },
    );
    expect(startedFrame).not.toContain("2 queued messages");
    releaseNext.resolve(undefined);
    await running;
    running = undefined;
    expect(
      (await session.read()).terminals.some(
        (terminal) => terminal.outcome === "completed",
      ),
    ).toBe(true);
    expect(next.pending.prompts.map((prompt) => prompt.text)).toEqual([
      "Another task",
      "Last task",
    ]);
  } finally {
    release.resolve(undefined);
    releaseNext.resolve(undefined);
    await running;
    await agent.close();
    fixture.close();
  }
});

test("queued message rows remain reachable by transcript scrolling", async () => {
  const fixture = createNativeSqliteOwnerFixture();
  const runtime = createCompatibilityRuntimeHost();
  const agent = await Shiitake.make({
    ...compatibilityRunDependencies(),
    store: fixture.owner,
    runtime: runtime.runtime,
  });
  const session = agent.session("scrolling-queue");
  try {
    for (let index = 1; index <= 8; index++) {
      await session.send(`Queue item ${String(index)}`, {
        delivery: "followUp",
        requestId: `scroll-${String(index)}`,
      });
    }
    await queuedFrame(
      agent,
      "scrolling-queue",
      `queue-scroll-${process.env.TUI_QUEUE_WIDTH ?? "80"}`,
      async (setup) => {
        const initial = setup.captureCharFrame();
        expect(initial).toContain("Queue item 8");
        expect(initial).not.toContain("queued messages");
        expect(initial).not.toContain("PgUp/PgDn scroll");
        await act(async () => {
          setup.mockInput.pressKey("\x1b[5~");
          await setup.renderOnce();
          await setup.renderOnce();
        });
        await act(async () =>
          setup.waitForFrame((frame) => frame.includes("Queue item 1")),
        );
        expect(setup.captureCharFrame()).toContain("Queue item 1");
        expect((await session.read()).pending.total).toBe(8);
      },
    );
  } finally {
    await agent.close();
    fixture.close();
  }
});
