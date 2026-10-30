import { expect, test } from "bun:test";
import { RGBA, parseKeypress, type KeyEvent } from "@opentui/core";
import { terminalPalette } from "@fungi.computer/stipe";
import { Shiitake, type ShiitakeAgent } from "@fungi.computer/shiitake";
import type { SessionPendingPrompt } from "@fungi.computer/shiitake/client";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
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
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fauxModel } from "@fungi.computer/mule/testing";
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
    await destroyTestRenderer(setup);
    commands.close();
    client.clear();
    notifyManager.setScheduler(defaultScheduler);
  }
}

for (const imageOnly of [false, true]) {
  test(`plain Up recalls and resends the newest native ${imageOnly ? "image-only" : "text"} payload`, async () => {
    const fixture = createNativeSqliteOwnerFixture();
    const runtime = createCompatibilityRuntimeHost();
    const agent = await Shiitake.make({
      ...compatibilityRunDependencies(),
      store: fixture.owner,
      runtime: runtime.runtime,
    });
    try {
      const session = agent.session("up-recall");
      const first = await session.send("A stays queued", {
        requestId: "recall-A",
        delivery: "followUp",
      });
      const text = imageOnly ? "" : "B recall target";
      const delivery = imageOnly ? "steer" : "followUp";
      const images: NonNullable<SessionPendingPrompt["images"]> = imageOnly
        ? [
            {
              type: "image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KQAAAABJRU5ErkJggg==",
              mimeType: "image/png",
            },
          ]
        : [];
      const second = await session.send(
        text,
        imageOnly
          ? { requestId: "recall-B", delivery, images }
          : { requestId: "recall-B", delivery },
      );
      await queuedFrame(
        agent,
        "up-recall",
        `recall-native${imageOnly ? "-images" : ""}-before`,
        async (setup) => {
          expect(setup.captureCharFrame()).not.toContain(
            "Up on an empty composer recalls your latest queued message",
          );
          const repeated = parseKeypress(Buffer.from("\u001b[57352;1:2u"), {
            useKittyKeyboard: true,
          });
          expect(repeated?.name).toBe("up");
          expect(repeated?.eventType).toBe("press");
          expect(repeated?.repeated).toBe(true);
          if (repeated === null) throw new Error("Kitty repeat did not decode");
          await act(async () => {
            setup.renderer.keyInput.processParsedKey(repeated);
            await setup.renderOnce();
          });
          expect(
            (await session.read()).pending.prompts.map(
              (prompt) => prompt.commandId,
            ),
          ).toEqual(
            imageOnly
              ? [second.commandId, first.commandId]
              : [first.commandId, second.commandId],
          );
          for (const modifier of [
            { shift: true },
            { ctrl: true },
            { meta: true },
          ]) {
            await act(async () => {
              setup.mockInput.pressArrow("up", modifier);
              await setup.renderOnce();
            });
            expect(
              (await session.read()).pending.prompts.map(
                (prompt) => prompt.commandId,
              ),
            ).toEqual(
              imageOnly
                ? [second.commandId, first.commandId]
                : [first.commandId, second.commandId],
            );
          }
          await act(async () => {
            setup.mockInput.pressArrow("up");
            await setup.renderOnce();
          });
          await act(async () =>
            setup.waitForFrame((frame) =>
              frame.includes(
                imageOnly ? "1 attached image(s)" : "› B recall target",
              ),
            ),
          );
          expect(
            (await session.read()).pending.prompts.map(
              (prompt) => prompt.commandId,
            ),
          ).toEqual([first.commandId]);
          await captureFrame(
            setup,
            process.env.TUI_QUEUE_SHOTS,
            `recall-native${imageOnly ? "-images" : ""}-after`,
          );
          await act(async () => {
            setup.mockInput.pressArrow("up");
            await setup.renderOnce();
          });
          expect(
            (await session.read()).pending.prompts.map(
              (prompt) => prompt.commandId,
            ),
          ).toEqual([first.commandId]);
          await act(async () => {
            setup.mockInput.pressEnter();
            await setup.renderOnce();
          });
          await act(async () =>
            setup.waitForFrame((frame) => frame.includes("› Ask anything")),
          );
          const pending = (await session.read()).pending.prompts;
          expect(pending).toHaveLength(2);
          const resent = pending.find(
            (prompt) => prompt.commandId !== first.commandId,
          );
          expect(resent).toMatchObject({ text, delivery });
          if (resent === undefined) throw new Error("Missing native resend");
          if (imageOnly) expect(resent.images).toEqual(images);
          expect(resent.requestId).not.toBe("recall-B");
          expect(resent.commandId).not.toBe(second.commandId);
          await act(async () => {
            setup.mockInput.pressArrow("up");
            await setup.renderOnce();
          });
          await act(async () =>
            setup.waitForFrame((frame) =>
              frame.includes(
                imageOnly ? "1 attached image(s)" : "› B recall target",
              ),
            ),
          );
          expect(
            (await session.read()).pending.prompts.map(
              (prompt) => prompt.commandId,
            ),
          ).toEqual([first.commandId]);
        },
      );
    } finally {
      await agent.close();
      fixture.close();
    }
  });
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
    expect(frame).toContain("● idle");
    expect(frame).not.toContain("queued for host");
    expect(frame.split("Reply once.")).toHaveLength(2);
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

test("a queued message stays faded while the status shows Agent activity, never its blocker", async () => {
  const fixture = createNativeSqliteOwnerFixture();
  const runtime = createCompatibilityRuntimeHost();
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const faux = fauxModel([
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
          retryable: () => false,
          model: faux.model,
          stream: faux.stream,
          release: () => Promise.resolve(),
        }),
    },
  });
  let running: Promise<void> | undefined;
  try {
    await agent
      .session("conversation-a")
      .command({ type: "title", title: "Lanes tick" });
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
      (setup) => {
        const queued = setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes("Second"));
        expect(queued).toBeDefined();
        expect((queued?.attributes ?? 0) & 2).toBe(2);
      },
    );
    expect(frame).toContain("● thinking");
    expect(frame).not.toContain("queued behind");
    expect(frame).not.toContain("Lanes tick");
    expect(frame).not.toContain("conversation-a");
    expect(frame.split("Second")).toHaveLength(2);
    expect(frame).not.toContain("PgUp/PgDn scroll");
    expect((await second.read()).activity.queue).toEqual({
      state: "queued",
      commandId: accepted.commandId,
      runningWork: {
        kind: "session",
        sessionId: "conversation-a",
        commandId: first.commandId,
        title: "Lanes tick",
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
      "queued",
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
        expect(frame.split("Second task")).toHaveLength(2);
        // This cue's row has only its caption, not a trailing status badge.
        expect(
          frame
            .split("\n")
            .find((line) => line.includes("Second task"))
            ?.trim(),
        ).toBe("Second task");
        expect(frame).not.toContain("PgUp/PgDn scroll");
        expect(frame).toContain("First task");
        expect(frame).toContain("Second task");
        expect(frame).toContain("Third task");
        expect(
          frame.split("\n").filter((line) => line.trim() === "queued"),
        ).toHaveLength(1);
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
  const faux = fauxModel([
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
          retryable: () => false,
          model: faux.model,
          stream: faux.stream,
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
    expect(frame).toContain("Active task");
    expect(frame).not.toContain("PgUp/PgDn scroll");
    expect(frame).toContain("Next task");
    expect(frame).toContain("Another task");
    expect(frame).toContain("Last task");
    expect(frame).not.toContain("queued behind");
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
