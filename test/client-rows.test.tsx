import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { defineClientEntry } from "@fungi.computer/shiitake/client-entry";
import { ExtensionId, type Json } from "@fungi.computer/shiitake/extensions";
import type { ParakeetSession } from "@fungi.computer/parakeet/headless";
import type { SessionExtensionSlots } from "@fungi.computer/shiitake/client";
import * as Schema from "effect/Schema";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";

const entry = defineClientEntry(
  {
    id: ExtensionId.make("rows-proof"),
    commands: {},
    projection: { schema: Schema.String },
  },
  {
    contribute: (view) => ({
      chips: [
        { id: "chip", order: 1, row: { id: "chip", title: "Probe ready" } },
      ],
      panel:
        view.status === "running"
          ? [
              {
                id: "panel",
                title: "Probe panel",
                detail: "Current state",
                open: {
                  params: [
                    { key: "agent", value: "other-agent" },
                    { key: "session", value: "other-session" },
                  ],
                },
                actions: [
                  {
                    id: "change",
                    label: "Change text",
                    input: { current: "old" },
                  },
                ],
              },
            ]
          : [],
      timeline: {
        cells: [
          {
            id: "1",
            sequence: 1,
            at: 1,
            commandId: null,
            rows: [{ id: "history", title: "Committed probe history" }],
          },
        ],
        omitted: 3,
      },
      waiting: null,
    }),
  },
);

test("keyboard row picker dispatches the owning catalog prompt and opens its target beside", async () => {
  notifyManager.setScheduler(queueMicrotask);
  const fixture = createTuiFixture();
  const slots: SessionExtensionSlots = {
    "rows-proof": {
      status: "running",
      revision: "sha256:proof",
      value: "ready",
      catalog: {
        protocol: "whistle.catalog/v1",
        commands: [
          {
            id: "change",
            title: "Change text",
            category: "Probe",
          },
        ],
      },
    },
  };
  const calls: unknown[] = [];
  const parseInput = Schema.decodeUnknownSync(
    Schema.Struct({
      current: Schema.String,
      answer: Schema.optional(Schema.String),
    }),
  );
  const session: ParakeetSession = {
    ...fixture.session,
    read: async (input) => ({
      ...(await fixture.session.read(input)),
      extensions: slots,
    }),
    watch: async (input) => {
      const watch = await fixture.session.watch(input);
      return { ...watch, snapshot: { ...watch.snapshot, extensions: slots } };
    },
    extension: (id) => ({
      call: (name, input): Promise<Json> => {
        calls.push([id, name, input]);
        const value = parseInput(input);
        if (value.answer === undefined)
          return Promise.resolve({
            type: "prompt",
            prompt: { type: "text", message: "New text" },
            next: { arguments: { current: value.current }, answer: "answer" },
          });
        return Promise.resolve({
          type: "done",
          notice: { type: "success", message: `Saved ${value.answer}` },
        });
      },
    }),
  };
  const opened: unknown[] = [];
  const peer = createTuiFixture();
  const commands = createWhistle();
  const query = createQueryClient();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        session={session}
        clients={[entry]}
        commands={commands}
        acquireSession={(target) => {
          opened.push(target);
          return Promise.resolve({
            session: {
              ...peer.session,
              address: "fixture://other-agent/other-session",
            },
            context: {},
            close: () => Promise.resolve(),
          });
        }}
      />
    </QueryClientProvider>,
    { width: 80, height: 24 },
  );
  const key = async (name: Parameters<typeof setup.mockInput.pressKey>[0]) => {
    act(() => {
      setup.mockInput.pressKey(name);
    });
    await act(async () => setup.renderOnce());
  };
  const frame = async (text: string) => {
    try {
      await act(async () =>
        setup.waitForFrame((value) => value.includes(text)),
      );
    } catch (cause) {
      throw new Error(`Expected native frame: ${text}`, { cause });
    }
  };
  const picker = async () => {
    act(() => {
      const row = commands
        .snapshot()
        .palette.find((row) => row.title === "Row actions");
      if (row === undefined)
        throw new Error("Row actions missing from palette");
      void commands.execute(row.commandId, { origin: "keyboard" });
    });
    await frame("Choose a row");
    await key("RETURN");
    await frame("Choose an action");
  };
  try {
    await frame("Probe panel");
    expect(setup.captureCharFrame()).toContain("Committed probe history");
    expect(setup.captureCharFrame()).toContain("earlier changes omitted");
    // The loop's own footer entry carries its panel row, its omitted-count
    // notice and its unanchored committed row together -- no separate
    // "Extension changes" block.
    await captureFrame(
      setup,
      process.env.TUI_EXTENSION_FOOTER_CAPTURE_DIR,
      "extension-changes-in-footer",
    );
    await picker();
    await key("ARROW_DOWN");
    await key("RETURN");
    await frame("New text");
    await act(async () => setup.mockInput.typeText("updated"));
    await key("RETURN");
    await act(async () =>
      setup.waitForFrame((value) => !value.includes("New text")),
    );
    expect(setup.captureCharFrame()).not.toContain("Saved updated");
    expect(calls).toEqual([
      ["rows-proof", "change", { current: "old" }],
      ["rows-proof", "change", { current: "old", answer: "updated" }],
    ]);
    expect(setup.captureCharFrame()).not.toContain("Enter close");
    expect(setup.captureCharFrame()).not.toContain("New text");
    await picker();
    await key("RETURN");
    await act(async () => setup.renderOnce());
    await act(async () => setup.waitForFrame(() => peer.watchCalls() === 1));
    expect(opened).toEqual([
      { agentId: "other-agent", sessionId: "other-session" },
    ]);
    expect(peer.watchCalls()).toBe(1);
    // The row's conversation opens beside this one; the parent stays open.
    expect(fixture.closeCalls()).toBe(0);
    expect(setup.captureCharFrame()).toContain("Probe panel");
    expect(fixture.watchCalls()).toBe(1);
  } finally {
    await destroyTestRenderer(setup);
    commands.close();
    query.clear();
    await fixture.waitForClose();
    if (peer.watchCalls() > 0) await peer.waitForClose();
    notifyManager.setScheduler(defaultScheduler);
  }
});
