import { expect, test } from "bun:test";
import { act } from "react";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import type { ParakeetSession } from "@fungi.computer/parakeet/headless";
import type { SessionExtensionSlots } from "@fungi.computer/shiitake/client";
import * as Schema from "effect/Schema";
import planClient from "@fungi.computer/shiitake-extensions/plan/client";
import {
  planContract,
  PlanProjection,
  type Plan,
} from "@fungi.computer/shiitake-extensions/plan";
import { sigilGutterText } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";

function inspectionScrolls(node: Renderable): ScrollBoxRenderable[] {
  return [
    ...(node instanceof ScrollBoxRenderable && !node.stickyScroll
      ? [node]
      : []),
    ...node.getChildren().flatMap(inspectionScrolls),
  ];
}

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  test(`plans expand only on command in the footer (${String(width)}×${String(height)})`, async () => {
    notifyManager.setScheduler(queueMicrotask);
    const fixture = createTuiFixture();
    let plan: Plan = {
      steps: [
        { step: "Trace the owner", status: "completed" },
        { step: "Wire the door", status: "in_progress" },
        { step: "Test the boundary", status: "pending" },
        { step: "Capture the result", status: "pending" },
        { step: "Ship it", status: "pending" },
      ],
    };
    let refuse = false;
    const calls: string[] = [];
    const inputs: unknown[] = [];
    const slots = (): SessionExtensionSlots => ({
      [planContract.id]: {
        status: "running",
        revision: "sha256:fixture",
        value: Schema.encodeSync(PlanProjection)({
          plan,
          history: {
            events: [
              { id: "1", sequence: 1, at: 1, commandId: null, event: plan },
            ],
            omitted: 0,
            nextSequence: 2,
          },
        }),
        catalog: {
          protocol: "whistle.catalog/v1",
          commands: [
            {
              id: "plan",
              title: "Plan",
              category: "Conversation",
              projections: { slash: { aliases: ["plan"] } },
            },
          ],
        },
      },
    });
    const session: ParakeetSession = {
      ...fixture.session,
      read: async (input) => ({
        ...(await fixture.session.read(input)),
        extensions: slots(),
      }),
      watch: async (input) => {
        const watch = await fixture.session.watch(input);
        return {
          ...watch,
          snapshot: { ...watch.snapshot, extensions: slots() },
        };
      },
      extension: () => ({
        call: (name, input) => {
          calls.push(name);
          inputs.push(input);
          return refuse
            ? Promise.reject(new Error("Plan unavailable"))
            : Promise.resolve({ type: "done" });
        },
      }),
    };
    const commands = createWhistle();
    const query = createQueryClient();
    const setup = await testRender(
      <QueryClientProvider client={query}>
        <TuiFrame
          initialTheme="mocha"
          session={session}
          clients={[planClient]}
          commands={commands}
        />
      </QueryClientProvider>,
      { width, height, kittyKeyboard: true },
    );
    const key = async (name: string) => {
      act(() => {
        setup.mockInput.pressKey(name);
      });
      await act(async () => setup.renderOnce());
    };
    const frame = async (text: string) =>
      act(async () => setup.waitForFrame((value) => value.includes(text)));
    const publish = async () => {
      const snapshot = await fixture.session.read();
      fixture.pushFrame({
        kind: "update",
        delivery: "live",
        cursor: "plan",
        messages: [],
        terminals: [],
        activity: snapshot.activity,
        pending: snapshot.pending,
        attention: snapshot.attention,
        extensions: slots(),
      });
    };
    try {
      if (process.env.TUI_PLAN_BASELINE_CAPTURE === "1") {
        await frame("Updated plan");
        await captureFrame(
          setup,
          process.env.TUI_PLAN_CAPTURE_DIR,
          `collapsed-${String(width)}`,
        );
        return;
      }
      await frame("Wire the door");
      expect(setup.captureCharFrame()).toContain("2/5");
      expect(setup.captureCharFrame()).not.toContain("Trace the owner");
      await captureFrame(
        setup,
        process.env.TUI_PLAN_CAPTURE_DIR,
        `collapsed-${String(width)}`,
      );
      await act(async () => setup.mockInput.typeText("/plan"));
      await key("RETURN");
      await frame("Trace the owner");
      const viewport = inspectionScrolls(setup.renderer.root)[0];
      if (viewport === undefined)
        throw new Error("Missing native inspection viewport");
      expect(viewport.viewport.height).toBe(5);
      expect(viewport.verticalScrollBar.visible).toBe(false);
      const expanded = setup.captureCharFrame();
      expect(
        expanded.split("\n").filter((line) => line.includes("Plan · 2/5")),
      ).toHaveLength(1);
      expect(expanded).not.toContain("Wire the door · 2/5");
      const header = expanded
        .split("\n")
        .find((line) => line.includes("Plan · 2/5"));
      expect(header?.indexOf("↑/↓ scroll")).toBeGreaterThan(width / 2);
      expect(expanded.indexOf("Trace the owner")).toBeGreaterThan(
        expanded.indexOf("Plan · 2/5"),
      );
      expect(expanded).toContain(`${sigilGutterText("●")}Trace the owner`);
      expect(expanded).toContain(`${sigilGutterText("●")}Wire the door`);
      expect(expanded).not.toContain("✔");
      expect(calls).toEqual(["plan"]);
      await captureFrame(
        setup,
        process.env.TUI_PLAN_CAPTURE_DIR,
        `expanded-${String(width)}`,
      );
      plan = {
        steps: [
          { step: "Live replacement", status: "in_progress" },
          ...Array.from({ length: 49 }, (_, index) => ({
            step: `Later step ${String(index)}`,
            status: "pending" as const,
          })),
        ],
      };
      await act(publish);
      await frame("Live replacement");
      for (let index = 0; index < 55; index++) await key("ARROW_DOWN");
      await frame("Later step 48");
      expect(viewport.viewport.height).toBeLessThanOrEqual(12);
      expect(viewport.verticalScrollBar.visible).toBe(true);
      await captureFrame(
        setup,
        process.env.TUI_PLAN_CAPTURE_DIR,
        `scrolled-${String(width)}`,
      );
      await key("ESCAPE");
      expect(setup.captureCharFrame()).not.toContain("Later step 48");
      await act(async () => setup.mockInput.typeText("Draft stays usable"));
      await frame("Draft stays usable");
      expect(fixture.cancelCalls()).toEqual([]);
      // A refused door must not reopen the inspection.
      refuse = true;
      await act(async () =>
        commands.execute(`${planContract.id}:plan`, { origin: "slash" }),
      );
      expect(setup.captureCharFrame()).not.toContain("↑/↓ scroll");
      // The human clears from the footer row through the plan owner's own command.
      refuse = false;
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
      await frame("Clear plan");
      await key("RETURN");
      await act(async () =>
        setup.waitForFrame(
          () => JSON.stringify(inputs.at(-1)) === `{"action":"clear"}`,
        ),
      );
      expect(inputs.at(-1)).toEqual({ action: "clear" });
      // Clearing acts on the row; it never opens the checklist it removes.
      expect(setup.captureCharFrame()).not.toContain("↑/↓ scroll");
      plan = { steps: [] };
      await act(publish);
      await act(async () =>
        setup.waitForFrame((value) => !value.includes("Live replacement")),
      );
      // A finished plan leaves the footer without deleting its history.
      plan = {
        steps: [
          { step: "Trace the owner", status: "completed" },
          { step: "Ship it", status: "completed" },
        ],
      };
      await act(publish);
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).not.toContain("Ship it");
      expect(setup.captureCharFrame()).not.toContain("Plan complete");
      await captureFrame(
        setup,
        process.env.TUI_PLAN_CAPTURE_DIR,
        `completed-${String(width)}`,
      );
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      query.clear();
      commands.close();
      await fixture.waitForClose();
      notifyManager.setScheduler(defaultScheduler);
    }
  });
}
