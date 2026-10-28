import { mkdir } from "node:fs/promises";
import { expect, test } from "bun:test";
import { act } from "react";
import type { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import {
  createWhistleKeymapAdapter,
  createWhistle,
} from "@fungi.computer/whistle";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { sigilGutterText } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import * as fixtures from "./fixture.js";
import { captureFrame } from "./frame-capture.js";

const states = [
  "idle",
  "panel",
  "prompt",
  "queued",
  "active",
  "waiting",
  "actions",
  "notice",
  "plan",
] as const;
/** What each state shows somewhere in the frame once it has settled. */
const settled = {
  idle: `${sigilGutterText("●")}idle`,
  panel: "Verify the garden change",
  prompt: "Water one bed",
  queued: `${sigilGutterText("●")}queued for host`,
  active: `${sigilGutterText("●")}streaming`,
  waiting: "Loop ·",
  actions: "Choose a row",
  notice: "Garden change saved.",
  plan: "Verify the garden change · 1/1",
};

/** The footer is status and model only: no key hints, no copy in their place. */
const footerHint =
  /Enter|Ctrl|Esc|Tab |PgUp|↑↓|send|panes|tool group|Tab queue|cancel or exit|dismiss|refresh|toggle|choose|complete|O open/u;

function footerLine(frame: string): string {
  const lines = frame.split("\n");
  const index = lines.findLastIndex((line) =>
    /^\s*● |^ (idle|streaming|queued|waiting)/u.test(line),
  );
  if (index < 0) throw new Error(`No footer row in frame:\n${frame}`);
  return lines[index] ?? "";
}

for (const { width, height } of [
  { width: 80, height: 24 },
  { width: 160, height: 48 },
]) {
  for (const state of states) {
    test(`native footer carries no key hints: ${state} at ${String(width)}x${String(height)}`, async () => {
      notifyManager.setScheduler(queueMicrotask);
      const fixture = fixtures.createTuiFixture({
        garden: state === "prompt",
        goal:
          state === "panel" || state === "actions" || state === "notice"
            ? {
                revision: "capture-goal",
                objective: "Verify the garden change",
                state: "active",
                startedAt: fixtures.fixtureGoalStartedAt,
                pauseCause: null,
              }
            : null,
        plan:
          state === "plan"
            ? {
                steps: [
                  { step: "Verify the garden change", status: "in_progress" },
                ],
              }
            : null,
        loop:
          state === "waiting"
            ? {
                loopId: "capture-loop",
                origin: "human",
                expiresAt: null,
                prompt: "Check the garden after CI finishes",
                mode: "self_paced",
                cron: null,
                state: "active",
                commandId: "capture-work",
                reason: "Waiting on CI",
                nextDueAt: Date.parse("2026-10-09T12:00:00Z"),
                lastError: null,
                consecutiveFailures: 0,
              }
            : null,
      });
      const query = createQueryClient();
      const commands = createWhistle();
      const setup = await testRender(
        <QueryClientProvider client={query}>
          <TuiFrame
            initialTheme="mocha"
            initialCommandNotice={
              state === "notice" ? "Garden change saved." : undefined
            }
            session={fixture.session}
            commands={commands}
            clients={fixtures.fixtureClients}
          />
        </QueryClientProvider>,
        { width, height },
      );
      const keymap = createDefaultOpenTuiKeymap(setup.renderer);
      const adapter = createWhistleKeymapAdapter(
        {
          registerLayer: (layer) =>
            keymap.registerLayer({
              bindings: layer.bindings,
              commands: layer.commands,
              target: setup.renderer.root,
              priority: 100,
            }),
        },
        commands,
        "keyboard",
      );
      try {
        await act(async () =>
          setup.waitForFrame((frame) => frame.includes(settled.idle)),
        );
        if (state === "prompt") {
          const alias = "water";
          await setup.waitFor(() =>
            commands
              .snapshot()
              .slash.some((command) => command.alias === alias),
          );
          await act(async () => setup.mockInput.typeText(`/${alias}`));
          await act(async () => setup.renderOnce());
          act(() => {
            setup.mockInput.pressKey("RETURN");
          });
        }
        if (state === "actions") {
          act(() => {
            const row = commands
              .snapshot()
              .palette.find((row) => row.title === "Row actions");
            if (row === undefined)
              throw new Error("Row actions missing from palette");
            void commands.execute(row.command, { origin: "keyboard" });
          });
        }
        if (state === "queued" || state === "active") {
          await act(async () => {
            await fixture.session.command({
              type: "prompt",
              requestId: "capture-next",
              text: "Verify the next garden change",
              delivery: "followUp",
            });
            if (state === "active") fixture.confirmLatestPrompt();
          });
        }
        await act(async () =>
          setup.waitForFrame((frame) => frame.includes(settled[state])),
        );
        const frame = setup.captureCharFrame();
        const footer = footerLine(frame);
        expect(footer).not.toMatch(footerHint);
        expect(frame).not.toContain("Esc nothing to cancel");
        if (state === "panel" || state === "notice")
          expect(frame).toContain("Pursuing goal since");
        if (state === "waiting") {
          const loopRows = frame
            .split("\n")
            .filter((line) => line.includes("Loop ·"));
          expect(loopRows).toHaveLength(1);
          const due = new Intl.DateTimeFormat(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }).format(Date.parse("2026-10-09T12:00:00Z"));
          expect(loopRows[0]).toContain(`Next ${due}`);
          expect(frame).not.toContain("Esc stop loop");
        }
        if (state === "plan") {
          expect(frame).toContain("Verify the garden change · 1/1");
        }
        const output = process.env.P4_NATIVE_CAPTURE_DIR;
        if (output !== undefined) {
          await mkdir(output, { recursive: true });
          await captureFrame(
            setup,
            output,
            `${state}-${String(width)}x${String(height)}`,
          );
        }
        if (state === "notice") {
          // A bare Escape is held by OpenTUI to distinguish longer sequences.
          // Render passes do not advance that input deadline: wait for the
          // parsed key itself before asserting the resulting UI state.
          const delivered = Promise.withResolvers<undefined>();
          const parsed = (key: KeyEvent) => {
            if (key.name === "escape") delivered.resolve(undefined);
          };
          setup.renderer.keyInput.prependListener("keypress", parsed);
          try {
            await act(async () => {
              setup.mockInput.pressEscape();
              await delivered.promise;
            });
            await act(async () =>
              setup.waitForFrame(
                (value) => !value.includes("Garden change saved."),
              ),
            );
          } finally {
            setup.renderer.keyInput.off("keypress", parsed);
          }
          expect(setup.captureCharFrame()).toContain("Pursuing goal since");
          expect(fixture.cancelCalls()).toHaveLength(0);
        }
        if (state === "active") {
          // Esc still stops the run; the stopping state carries no hint either.
          const delivered = Promise.withResolvers<undefined>();
          const parsed = (key: KeyEvent) => {
            if (key.name === "escape") delivered.resolve(undefined);
          };
          setup.renderer.keyInput.prependListener("keypress", parsed);
          try {
            await act(async () => {
              setup.mockInput.pressEscape();
              await delivered.promise;
            });
            await act(async () =>
              setup.waitFor(() => fixture.cancelCalls().length === 1),
            );
          } finally {
            setup.renderer.keyInput.off("keypress", parsed);
          }
          await act(async () => setup.renderOnce());
          expect(footerLine(setup.captureCharFrame())).not.toMatch(footerHint);
        }
        if (state === "idle") {
          // Enter still sends the draft.
          const before = fixture.promptCalls();
          await act(async () => setup.mockInput.typeText("Send this draft"));
          await act(async () => {
            setup.mockInput.pressEnter();
            await setup.waitFor(() => fixture.promptCalls() === before + 1);
          });
          expect(footerLine(setup.captureCharFrame())).not.toMatch(footerHint);
        }
      } finally {
        adapter.cleanup();
        await destroyTestRenderer(setup);
        commands.close();
        query.clear();
        await fixture.waitForClose();
        notifyManager.setScheduler(defaultScheduler);
      }
    });
  }
}
