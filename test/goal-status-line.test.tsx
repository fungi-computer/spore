import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import {
  goalContract,
  type EndedGoal,
  type Goal,
} from "@fungi.computer/shiitake-extensions/goal";
import goalClient from "@fungi.computer/shiitake-extensions/goal/client";
import type { SessionSnapshot } from "@fungi.computer/shiitake/client";
import { TuiFrame } from "../src/frame.js";
import {
  createDesignTuiFixture,
  groupedToolsDesignSnapshot,
} from "./design-fixture.js";

const startedAt = Date.parse("2026-10-18T14:02:00.000Z");
const objective = "Tidy the menus";
const goalOrigin = { extensionId: goalContract.id, correlation: "set:menus" };

/** One person's question, then a hidden goal turn and its visible reply. */
const messages: SessionSnapshot["messages"] = [
  {
    id: "human",
    sequence: 1,
    commandId: "human-command",
    value: { role: "user", content: "What should we eat?", timestamp: 1 },
  },
  {
    id: "goal-turn",
    sequence: 2,
    commandId: "goal-work",
    origin: goalOrigin,
    value: { role: "user", content: `Goal turn · ${objective}`, timestamp: 2 },
  },
  {
    id: "goal-reply",
    sequence: 3,
    commandId: "goal-work",
    value: {
      role: "assistant",
      content: [{ type: "text", text: "The menus are tidy." }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-6-sol",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 3,
    },
  },
];

async function render(
  goal: Goal | null,
  ended: readonly EndedGoal[],
  following: SessionSnapshot["messages"] = [],
  history: SessionSnapshot["messages"] = messages,
) {
  const snapshot: SessionSnapshot = {
    ...groupedToolsDesignSnapshot,
    messages: [...history, ...following],
    pending: { total: 0, hasMore: false, prompts: [] },
    extensions: {
      [goalContract.id]: {
        status: "running",
        revision: "sha256:goal-status",
        value: { goal, ended, omitted: 0 },
        // The footer's Pause/Resume action names the advertised goal command.
        catalog: {
          protocol: "whistle.catalog/v1",
          commands: [{ id: "goal", title: "Goal", category: "Conversation" }],
        },
      },
    },
  };
  const fixture = createDesignTuiFixture({ snapshot });
  const query = createQueryClient();
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        session={fixture.session}
        clients={[goalClient]}
        commands={commands}
        initialTheme="mocha"
      />
    </QueryClientProvider>,
    { width: 100, height: 30 },
  );
  await act(async () =>
    setup.waitForFrame((frame) =>
      frame.includes(
        history.length === 0 ? "Goal cleared" : "The menus are tidy.",
      ),
    ),
  );
  await act(async () => setup.renderOnce());
  return {
    frame: setup.captureCharFrame(),
    close: async () => {
      await destroyTestRenderer(setup);
      query.clear();
      commands.close();
    },
  };
}

const lines = (frame: string, text: string) =>
  frame.split("\n").filter((line) => line.includes(text));

test("R2 TUI footer: a live goal is one line, 'Pursuing goal since HH:MM', and no other goal state shows", async () => {
  const view = await render(
    {
      revision: "set:menus",
      objective,
      state: "active",
      startedAt,
      pauseCause: null,
    },
    [],
  );
  try {
    const live = lines(view.frame, "Pursuing goal since");
    expect(live).toHaveLength(1);
    expect(live[0]?.trim()).toMatch(
      /^● Pursuing goal since \d\d:\d\d · Tidy the menus$/u,
    );
    expect(view.frame).not.toContain("Goal ·");
    expect(view.frame).not.toContain("Goal active");
    // R5: the hidden goal turn never shows in the chat.
    expect(view.frame).not.toContain("Goal turn ·");
  } finally {
    await view.close();
  }
});

test("R2 TUI footer: a paused goal reads 'Goal paused (/goal resume)' with why it paused", async () => {
  const view = await render(
    {
      revision: "set:menus",
      objective,
      state: "paused",
      startedAt,
      pauseCause: { kind: "cancelled", detail: "Stopped" },
    },
    [],
  );
  try {
    expect(lines(view.frame, "Goal paused").map((line) => line.trim())).toEqual(
      ["● Goal paused (/goal resume) · Tidy the menus · Stopped"],
    );
    expect(view.frame).not.toContain("Pursuing goal");
  } finally {
    await view.close();
  }
});

test("R3 TUI chat: an achieved goal leaves the footer and posts one chat line after its last work", async () => {
  const view = await render(null, [
    {
      sequence: 1,
      objective,
      outcome: "achieved",
      reason: "Menus are tidy and verified",
      endedAt: startedAt + 60_000,
      afterSequence: 3,
    },
  ]);
  try {
    expect(lines(view.frame, "Goal achieved")).toHaveLength(1);
    expect(
      view.frame.indexOf("Goal achieved · Tidy the menus"),
    ).toBeGreaterThan(view.frame.indexOf("The menus are tidy."));
    expect(view.frame).not.toContain("Pursuing goal");
    expect(view.frame).not.toContain("Goal paused");
    expect(view.frame).not.toContain("Goal turn ·");
  } finally {
    await view.close();
  }
});

test.each(["settled", "steered"])(
  "a cleared goal stays before two later messages instead of lingering at the bottom (%s work)",
  async (work) => {
    const workContinues = work === "steered";
    const view = await render(
      null,
      [
        {
          sequence: 1,
          objective,
          outcome: "cleared",
          reason: null,
          endedAt: startedAt + 60_000,
          afterSequence: 3,
        },
      ],
      [
        {
          id: "first-after-clear",
          sequence: 4,
          commandId: "first-after-clear-command",
          value: {
            role: "user",
            content: "First message after clearing",
            timestamp: startedAt + 61_000,
          },
        },
        {
          id: "second-after-clear",
          sequence: 5,
          commandId: "second-after-clear-command",
          value: {
            role: "user",
            content: "Second message after clearing",
            timestamp: startedAt + 62_000,
          },
        },
        // A steer has its own prompt command, but subsequent assistant messages
        // still belong to the running work (Woodstock's client projection).
        ...(workContinues
          ? messages.flatMap((message): SessionSnapshot["messages"] =>
              message.value.role === "assistant"
                ? [
                    {
                      ...message,
                      id: "reply-after-steers",
                      sequence: 6,
                      value: {
                        ...message.value,
                        content: [
                          {
                            type: "text",
                            text: "Answer after the two new messages.",
                          },
                        ],
                        timestamp: startedAt + 63_000,
                      },
                    },
                  ]
                : [],
            )
          : []),
      ],
    );
    try {
      expect(lines(view.frame, "Goal cleared")).toHaveLength(1);
      const cleared = view.frame.indexOf("Goal cleared · Tidy the menus");
      expect(cleared).toBeGreaterThan(
        view.frame.indexOf("The menus are tidy."),
      );
      expect(
        view.frame.indexOf("First message after clearing"),
      ).toBeGreaterThan(cleared);
      expect(
        view.frame.indexOf("Second message after clearing"),
      ).toBeGreaterThan(cleared);
    } finally {
      await view.close();
    }
  },
);

test("a goal cleared before any Session entry renders once in the transcript, not in the footer", async () => {
  const view = await render(
    null,
    [
      {
        sequence: 1,
        objective,
        outcome: "cleared",
        reason: null,
        endedAt: startedAt,
        afterSequence: 0,
      },
    ],
    [],
    [],
  );
  try {
    expect(lines(view.frame, "Goal cleared")).toHaveLength(1);
    expect(view.frame).not.toContain("Start a conversation.");
    expect(view.frame).not.toContain("Extension changes");
  } finally {
    await view.close();
  }
});
