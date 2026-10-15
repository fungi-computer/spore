import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { type Renderable } from "@opentui/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { goalContract } from "@fungi.computer/shiitake-extensions/goal";
import { loopContract } from "@fungi.computer/shiitake-extensions/loop";
import loopClient from "@fungi.computer/shiitake-extensions/loop/client";
import goalClient from "@fungi.computer/shiitake-extensions/goal/client";
import type { SessionSnapshot } from "@fungi.computer/shiitake/client";
import { TuiFrame } from "../src/frame.js";
import {
  createDesignTuiFixture,
  groupedToolsDesignSnapshot,
} from "./design-fixture.js";

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}

for (const { width, height } of [
  { width: 80, height: 24 },
  { width: 160, height: 48 },
]) {
  for (const pending of [false, true]) {
    test(`Goal turn is one muted row; human text stays a bubble (${String(width)}x${String(height)}, ${pending ? "queued" : "confirmed"})`, async () => {
      const text = "Goal turn · Keep the menus tidy";
      const origin = {
        extensionId: goalContract.id,
        correlation: "goal-revision",
      };
      const snapshot: SessionSnapshot = {
        ...groupedToolsDesignSnapshot,
        messages: [
          {
            id: "set-goal",
            sequence: 1,
            commandId: "set-goal-command",
            origin: { extensionId: goalContract.id, correlation: null },
            value: {
              role: "user",
              content: "Keep the menus tidy",
              timestamp: 1,
            },
          },
          {
            id: "human",
            sequence: 2,
            commandId: "human-command",
            value: { role: "user", content: text, timestamp: 1 },
          },
          {
            id: "loop-turn",
            sequence: 3,
            commandId: "loop-command",
            origin: {
              extensionId: loopContract.id,
              correlation: "loop-revision",
            },
            value: { role: "user", content: "Check the kiln", timestamp: 2 },
          },
          ...(pending
            ? []
            : [
                {
                  id: "goal-turn",
                  sequence: 4,
                  commandId: "goal-command",
                  origin,
                  value: { role: "user" as const, content: text, timestamp: 2 },
                },
              ]),
        ],
        pending: {
          total: pending ? 1 : 0,
          hasMore: false,
          prompts: pending
            ? [
                {
                  commandId: "goal-command",
                  text,
                  delivery: "followUp",
                  origin,
                },
              ]
            : [],
        },
      };
      const fixture = createDesignTuiFixture({ snapshot });
      const query = createQueryClient();
      const commands = createWhistle();
      const setup = await testRender(
        <QueryClientProvider client={query}>
          <TuiFrame
            session={fixture.session}
            clients={[goalClient, loopClient]}
            commands={commands}
            initialTheme="mocha"
          />
        </QueryClientProvider>,
        { width, height },
      );
      try {
        await act(async () =>
          setup.waitForFrame((frame) => frame.includes(text)),
        );
        const rows = descendants(setup.renderer.root).filter((node) =>
          node.id.startsWith("tui-timeline-row:"),
        );
        expect(rows.map((row) => row.height)).toEqual([3, 3, 3, 1]);
        const lines = setup
          .captureSpans()
          .lines.filter((line) =>
            line.spans.some((span) => span.text.includes(text)),
          );
        expect(lines).toHaveLength(2);
        const human = lines[0]?.spans.find((span) => span.text.includes(text));
        const goal = lines[1]?.spans.find((span) => span.text.includes(text));
        expect(human?.attributes).toBe(1);
        expect(goal?.attributes).toBe(2);
        expect(setup.captureCharFrame()).not.toContain("forage.search");
        expect(setup.captureCharFrame()).not.toContain("goal.get_goal");
      } finally {
        act(() => {
          setup.renderer.destroy();
        });
        query.clear();
        commands.close();
      }
    });
  }
}
