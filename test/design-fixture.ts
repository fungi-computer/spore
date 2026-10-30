import {
  idleActivity,
  runningActivity,
} from "@fungi.computer/parakeet-testing";
import type {
  ParakeetSession,
  ParakeetToolArguments,
} from "@fungi.computer/parakeet/headless";
import type {
  SessionExtensionSlots,
  SessionMessage,
  SessionSnapshot,
} from "@fungi.computer/shiitake/client";
import {
  goalContract,
  type Goal,
} from "@fungi.computer/shiitake-extensions/goal";

import {
  createTuiFixture,
  type TuiFixture,
  type TuiFixtureOptions,
} from "./fixture.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const reviewUsage = {
  input: 418,
  output: 186,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 604,
  cost: {
    input: 0.000_418,
    output: 0.001_86,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.002_278,
  },
};

function representativeMessages(sequenceOffset = 0): readonly SessionMessage[] {
  return [
    {
      id: "design-user-layout",
      commandId: "design-request-layout",
      sequence: sequenceOffset + 1,
      value: {
        role: "user",
        content:
          "Review the terminal conversation layout. Keep Markdown readable and make tool activity easy to scan.",
        timestamp: sequenceOffset + 1,
      },
    },
    {
      id: "design-assistant-layout",
      commandId: null,
      sequence: sequenceOffset + 2,
      value: {
        role: "assistant",
        api: "pi",
        provider: "camel",
        model: "auto",
        content: [
          {
            type: "text",
            text: [
              "I’ll inspect the current frame and focus on three things:",
              "",
              "- **Hierarchy:** prompts and replies should be distinct.",
              "- **Tool work:** arguments and results should be easy to scan.",
              "- **Flow:** the newest activity should remain visible.",
              "",
              "```tsx",
              "<TuiFrame session={session} commands={commands} />",
              "```",
              "",
              "Then I’ll compare the normal and narrow views.",
            ].join("\n"),
          },
          {
            type: "toolCall",
            id: "design-call-read-frame",
            name: "execute",
            arguments: {
              code: "const contents=await files.read({path:'apps/tui/src/frame.tsx'});return contents;",
              limit: 20,
            },
          },
        ],
        stopReason: "toolUse",
        timestamp: sequenceOffset + 2,
        usage: reviewUsage,
      },
    },
    {
      id: "design-result-read-frame",
      data: { path: "apps/tui/src/frame.tsx" },
      commandId: null,
      sequence: sequenceOffset + 3,
      value: {
        role: "toolResult",
        toolCallId: "design-call-read-frame",
        toolName: "execute",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: "apps/tui/src/frame.tsx",
              note: "Read apps/tui/src/frame.tsx.",
              content:
                'import { useState } from "react";\n\nexport const status = "ready";\n',
              offset: 0,
              nextOffset: null,
              truncated: false,
            }),
          },
        ],
        isError: false,
        timestamp: sequenceOffset + 3,
      },
    },
    {
      id: "design-assistant-summary",
      commandId: null,
      sequence: sequenceOffset + 4,
      value: {
        role: "assistant",
        api: "pi",
        provider: "camel",
        model: "auto",
        content: [
          {
            type: "text",
            text: "The frame has the right typed rows. I’ll preserve that structure while giving Markdown and tool output enough room to breathe.",
          },
        ],
        stopReason: "stop",
        timestamp: sequenceOffset + 4,
        usage: zeroUsage,
      },
    },
    {
      id: "design-user-narrow",
      commandId: "design-request-narrow",
      sequence: sequenceOffset + 5,
      value: {
        role: "user",
        content:
          "Good. Check the 48-column view too, and keep the latest work visible while it runs.",
        timestamp: sequenceOffset + 5,
      },
    },
  ];
}

const designGoal: Goal = {
  revision: "design-goal",
  objective: "Polish the terminal review",
  state: "active",
  startedAt: Date.parse("2026-10-18T14:02:00.000Z"),
  pauseCause: null,
};
const designGoalSlots: SessionExtensionSlots = {
  [goalContract.id]: {
    status: "running",
    revision: "sha256:design",
    value: {
      goal: designGoal,
      ended: [],
      omitted: 0,
    },
    catalog: {
      protocol: "whistle.catalog/v1",
      commands: [{ id: "goal", title: "Session goal", category: "Session" }],
    },
  },
};

/** Compact rich conversation with one replaceable assistant progress row. */
export const representativeDesignSnapshot: SessionSnapshot = {
  attention: [],
  pending: { total: 0, prompts: [], hasMore: false },
  sessionId: "tui-design-review",
  cursor: "design-cursor-short",
  hasMore: false,
  messages: representativeMessages(),
  terminals: [],
  activity: runningActivity(),
  extensions: designGoalSlots,
  toolOutput: [],
  progress: {
    messageId: "design-assistant-narrow",
    revision: 3,
    text: [
      "I’m checking the **48-column** frame now.",
      "",
      "- wrapped Markdown stays inside the viewport",
      "- the newest response remains visible",
    ].join("\n"),
    thinking: "Comparing the narrow frame with the normal-width layout.",
    textTruncated: false,
    thinkingTruncated: false,
    textOffset: 0,
    thinkingOffset: 0,
  },
};

const historyTurns = [
  [
    "Start with the real terminal caller. What owns the conversation state?",
    "`TuiFrame` consumes Parakeet’s headless timeline, composer, and status hooks; the typed Session remains the state boundary.",
  ],
  [
    "What should happen when the viewport is shorter than the history?",
    "The conversation should scroll while the composer stays fixed and reachable.",
  ],
  [
    "Which content needs richer presentation first?",
    "Assistant Markdown and exact tool calls carry the most structure, so they are the useful first review slice.",
  ],
  [
    "Does the fixture need a provider or local runtime?",
    "No. A typed Session snapshot exercises the same projection without introducing live data.",
  ],
  [
    "Keep the tool result visible after completion.",
    "The result stays joined to its call by the exact Pi tool-call identity.",
  ],
  [
    "Make sure a narrow terminal still shows who said what.",
    "Role markers and spacing remain visible even when prose wraps across several rows.",
  ],
] as const;

const historyMessages: readonly SessionMessage[] = historyTurns.flatMap(
  ([prompt, reply], index): SessionMessage[] => {
    const sequence = index * 2;
    return [
      {
        id: `design-history-user-${String(index + 1)}`,
        commandId: `design-history-request-${String(index + 1)}`,
        sequence: sequence + 1,
        value: { role: "user", content: prompt, timestamp: sequence + 1 },
      },
      {
        id: `design-history-assistant-${String(index + 1)}`,
        commandId: null,
        sequence: sequence + 2,
        value: {
          role: "assistant",
          api: "pi",
          provider: "camel",
          model: "auto",
          content: [{ type: "text", text: reply }],
          stopReason: "stop",
          timestamp: sequence + 2,
          usage: zeroUsage,
        },
      },
    ];
  },
);

const longRepresentativeMessages = representativeMessages(
  historyMessages.length,
);
const activeToolSequence =
  historyMessages.length + longRepresentativeMessages.length + 1;

const activeToolMessage: SessionMessage = {
  id: "design-assistant-narrow",
  commandId: null,
  sequence: activeToolSequence,
  value: {
    role: "assistant",
    api: "pi",
    provider: "camel",
    model: "auto",
    content: [
      {
        type: "text",
        text: "The 48-column layout is ready for a native render check.",
      },
      {
        type: "toolCall",
        id: "design-call-render-narrow",
        name: "execute",
        arguments: {
          code: "return await terminal.render({ width: 48, height: 18 });",
        },
      },
    ],
    stopReason: "toolUse",
    timestamp: activeToolSequence,
    usage: zeroUsage,
  },
};

/** Taller history ending after progress resolves into one running tool call. */
export const longHistoryDesignSnapshot: SessionSnapshot = {
  attention: [],
  pending: { total: 0, prompts: [], hasMore: false },
  sessionId: "tui-design-review-long",
  cursor: "design-cursor-long",
  hasMore: false,
  messages: [
    ...historyMessages,
    ...longRepresentativeMessages,
    activeToolMessage,
  ],
  terminals: [],
  activity: runningActivity({ activeTool: "execute" }),
  toolOutput: [],
  progress: null,
  extensions: designGoalSlots,
};

/** The finished run that leaves a design Session waiting for a person. */
const completedDesignRun: SessionSnapshot["terminals"][number] = {
  commandId: "design-command",
  outcome: "completed",
  sequence: 9_999,
  diagnostic: null,
};

/** The same tool call after a failed native render result arrives. */
export const failedToolDesignSnapshot: SessionSnapshot = {
  ...longHistoryDesignSnapshot,
  activity: idleActivity,
  terminals: [completedDesignRun],
  messages: [
    ...longHistoryDesignSnapshot.messages,
    {
      id: "design-result-render-narrow",
      commandId: null,
      sequence: activeToolSequence + 1,
      value: {
        role: "toolResult",
        toolCallId: "design-call-render-narrow",
        toolName: "execute",
        content: [
          {
            type: "text",
            text: "The render check could not open its output directory.",
          },
        ],
        isError: true,
        timestamp: activeToolSequence + 1,
      },
    },
  ],
};

/** The existing two tool calls without intervening prose, for disclosure input. */
export const toolDisclosuresDesignSnapshot: SessionSnapshot = {
  ...longHistoryDesignSnapshot,
  messages: longHistoryDesignSnapshot.messages.flatMap(
    (message): SessionMessage[] => {
      if (message.value.role === "toolResult") return [message];
      if (message.value.role !== "assistant") return [];
      const content = message.value.content.filter(
        (part) => part.type === "toolCall",
      );
      return content.length === 0
        ? []
        : [{ ...message, value: { ...message.value, content } }];
    },
  ),
};

export type DesignTuiFixtureOptions = TuiFixtureOptions &
  Readonly<{ snapshot?: SessionSnapshot | undefined }>;

/** Reuse the interactive fixture lifecycle with a rich initial Session cut. */
export function createDesignTuiFixture({
  snapshot = representativeDesignSnapshot,
  ...fixtureOptions
}: DesignTuiFixtureOptions = {}): TuiFixture {
  const fixture = createTuiFixture({ ...fixtureOptions, goal: designGoal });
  const session: ParakeetSession = {
    latestPending: () =>
      Promise.resolve(snapshot.pending.prompts.at(-1) ?? null),
    withdraw: () => Promise.resolve({ status: "unknown" }),
    address: `${fixture.session.address}/${snapshot.sessionId}`,
    command: fixture.session.command,
    extension: fixture.session.extension,
    read: () => Promise.resolve(snapshot),
    watch: async (options) => {
      const watch = await fixture.session.watch(options);
      return { ...watch, snapshot };
    },
  };
  return { ...fixture, session };
}

type DesignCall = Readonly<{
  id: string;
  name: string;
  arguments: ParakeetToolArguments;
  output: string;
  isError?: boolean;
  elapsed: number;
}>;

const groupedCalls: readonly DesignCall[] = [
  {
    id: "group-read-frame",
    name: "read",
    arguments: { path: "apps/tui/src/frame.tsx" },
    output:
      'import { useState } from "react";\n\nexport const status = "ready";',
    elapsed: 42,
  },
  {
    id: "group-read-transcript",
    name: "read",
    arguments: { path: "apps/tui/src/transcript.tsx" },
    output: "export const TerminalTranscript = memo(TerminalTranscriptView);",
    elapsed: 38,
  },
  {
    id: "group-grep",
    name: "grep",
    arguments: { pattern: "ToolRow", path: "apps/tui/src" },
    output: "apps/tui/src/transcript.tsx:121: function ToolRow({",
    elapsed: 120,
  },
  {
    id: "group-patch",
    name: "apply_patch",
    arguments: {
      patch: [
        "*** Begin Patch",
        "*** Update File: apps/tui/src/transcript.tsx",
        "@@ function ToolRow({",
        "   const { colors } = presentation;",
        "-  const tone = colors.info;",
        "+  const tone = statusTone(item.status, presentation);",
        "*** End Patch",
      ].join("\n"),
    },
    output: JSON.stringify({
      status: "completed",
      exitCode: 0,
      stdout:
        "Success. Updated the following files:\nM apps/tui/src/transcript.tsx",
      stderr: "",
      truncated: false,
    }),
    elapsed: 310,
  },
  {
    id: "group-test",
    name: "bash",
    arguments: { command: "pnpm --dir apps/tui run test" },
    output: JSON.stringify({
      exitCode: 1,
      stdout: Array.from(
        { length: 18 },
        (_, index) => `✓ transcript row ${String(index + 1)}`,
      ).join("\n"),
      stderr: "✗ groups fold consecutive calls\n  expected 1 group, received 2",
    }),
    isError: true,
    elapsed: 4_200,
  },
  {
    id: "group-typecheck",
    name: "bash",
    arguments: { command: "pnpm --dir apps/tui run typecheck" },
    output: "tsc -p tsconfig.json --noEmit",
    elapsed: 2_900,
  },
];

function groupedMessages(
  calls: readonly DesignCall[],
  running: DesignCall | undefined,
): SessionMessage[] {
  let sequence = 0;
  const at = () => {
    sequence += 1;
    return sequence;
  };
  const messages: SessionMessage[] = [
    {
      id: "group-user",
      commandId: "group-request",
      sequence: at(),
      value: {
        role: "user",
        content: "Group the tool calls in the transcript and run the tests.",
        timestamp: sequence * 10_000,
      },
    },
    {
      id: "group-intro",
      commandId: null,
      sequence: at(),
      value: {
        role: "assistant",
        api: "pi",
        provider: "camel",
        model: "auto",
        content: [
          {
            type: "text",
            text: "I’ll read the transcript, patch it, then test.",
          },
        ],
        stopReason: "stop",
        timestamp: sequence * 10_000,
        usage: reviewUsage,
      },
    },
  ];
  const assistantCall = (call: DesignCall): SessionMessage => ({
    id: `assistant-${call.id}`,
    commandId: null,
    sequence: at(),
    value: {
      role: "assistant",
      api: "pi",
      provider: "camel",
      model: "auto",
      content: [
        {
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        },
      ],
      stopReason: "toolUse",
      timestamp: sequence * 10_000,
      usage: zeroUsage,
    },
  });
  for (const call of calls) {
    const assistant = assistantCall(call);
    const started = assistant.sequence * 10_000;
    messages.push(assistant, {
      id: `result-${call.id}`,
      commandId: null,
      sequence: at(),
      value: {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: call.output }],
        isError: call.isError ?? false,
        timestamp: started + call.elapsed,
      },
    });
  }
  if (running !== undefined) messages.push(assistantCall(running));
  else
    messages.push({
      id: "group-summary",
      commandId: null,
      sequence: at(),
      value: {
        role: "assistant",
        api: "pi",
        provider: "camel",
        model: "auto",
        content: [
          {
            type: "text",
            text: "One test failed; the typecheck passes. I’ll fix the failing assertion next.",
          },
        ],
        stopReason: "stop",
        timestamp: sequence * 10_000,
        usage: reviewUsage,
      },
    });
  return messages;
}

/** Six consecutive calls of mixed kinds (read, search, edit, commands, one failure). */
export const groupedToolsDesignSnapshot: SessionSnapshot = {
  ...representativeDesignSnapshot,
  sessionId: "tui-design-grouped-tools",
  activity: idleActivity,
  terminals: [completedDesignRun],
  toolOutput: [],
  progress: null,
  messages: groupedMessages(groupedCalls, undefined),
};

/** The same run while the final command is still executing. */
export const runningToolsDesignSnapshot: SessionSnapshot = {
  ...representativeDesignSnapshot,
  sessionId: "tui-design-running-tools",
  activity: runningActivity({
    queue: { state: "running", commandId: "group-request" },
    activeTool: "bash",
  }),
  toolOutput: [],
  progress: null,
  messages: groupedMessages(
    groupedCalls.filter((call) => call.isError !== true).slice(0, 4),
    groupedCalls.at(-1),
  ),
};
