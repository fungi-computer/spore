import { mkdir } from "node:fs/promises";
import process from "node:process";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import type { ParakeetSession } from "@fungi.computer/parakeet/headless";
import type {
  SessionExtensionSlots,
  SessionMessage,
} from "@fungi.computer/shiitake/client";
import type { Json } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import questionClient from "@fungi.computer/shiitake-extensions/question/client";
import {
  AnswerFlowInput,
  AskProjection,
  questionContract,
} from "@fungi.computer/shiitake-extensions/question";
import { TuiFrame } from "../src/frame.js";
import { createRoot } from "@opentui/react";
import { openTerminalApplication } from "../src/terminal-application.js";
import { renderTuiConversation } from "../src/frame-renderer.js";
import { pressDecodedKey } from "./native-readiness.js";
import { createTuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";

export const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A short conversation, so the transcript above the composer is real. */
export const transcript: SessionMessage[] = [
  {
    id: "shots-user",
    commandId: "shots-request",
    sequence: 1,
    value: {
      role: "user",
      content: "Set up note storage for the garden app.",
      timestamp: 10_000,
    },
  },
  {
    id: "shots-assistant",
    commandId: null,
    sequence: 2,
    value: {
      role: "assistant",
      api: "pi",
      provider: "camel",
      model: "auto",
      content: [
        {
          type: "text",
          text: "I can wire this up two ways, so I need a few decisions from you before I write any code.",
        },
      ],
      stopReason: "stop",
      timestamp: 20_000,
      usage,
    },
  },
];

const encode = Schema.encodeSync(AskProjection);
const decode = Schema.decodeUnknownSync(AnswerFlowInput);
export const asks = [
  {
    askId: "question-color",
    text: "Which color should we use?",
    multiple: false,
  },
  {
    askId: "question-storage",
    text: "Where should the notes live?",
    multiple: false,
  },
  {
    askId: "question-ship",
    text: "Which deliverables should ship?",
    multiple: true,
  },
];

const answered = Schema.is(
  Schema.Struct({
    stage: Schema.Literal("decision"),
    answer: Schema.Json,
  }),
);

/** One fixture ask, optionally waiting on the Agent that sent the work. */
type FixtureAsk = (typeof asks)[number] &
  Readonly<{
    waitingOn?: Readonly<{ agentId: string; sessionId: string; name: string }>;
  }>;

/** The projected ask; a routed one names the Agent it waits on. */
function projectAsk(
  ask: FixtureAsk,
): (typeof AskProjection.Type)["asks"][number] {
  const open: (typeof AskProjection.Type)["asks"][number] = {
    askId: ask.askId,
    createdAt: 1,
    expiresAt: null,
    status: "parked",
    questions: [
      {
        id: "decision",
        header: "Decision",
        question: ask.text,
        options: [
          { label: "Blue", description: "Blue theme" },
          { label: "Green", description: "Green theme" },
          { label: "Teal", description: "Teal theme" },
        ],
        multiple: ask.multiple,
      },
    ],
  };
  if (ask.waitingOn === undefined) return open;
  return { ...open, waitingOn: ask.waitingOn };
}

/** A Session whose question extension asks and answers the way the real one does. */
function questionSession(fixture: ReturnType<typeof createTuiFixture>) {
  let pending: readonly FixtureAsk[] = [];
  let failAnswers = false;
  const calls: [string, Json][] = [];
  const slots = (): SessionExtensionSlots => ({
    [questionContract.id]: {
      status: "running",
      revision: `sha256:${pending.map((ask) => ask.askId).join("-")}`,
      value: encode({
        asks: pending.map(projectAsk),
      }),
      catalog: {
        protocol: "whistle.catalog/v1",
        commands: [
          {
            id: "answerFlow",
            title: "Answer a question",
            category: "Conversation",
          },
        ],
      },
    },
  });
  const publish = async () => {
    const snapshot = await fixture.session.read();
    fixture.pushFrame({
      kind: "update",
      delivery: "live",
      cursor: "question-fixture",
      messages: [],
      terminals: [],
      activity: snapshot.activity,
      pending: snapshot.pending,
      attention: snapshot.attention,
      extensions: slots(),
    });
  };
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
      call: async (name, input): Promise<Json> => {
        calls.push([name, input]);
        const parsed = decode(input);
        const ask = asks.find(
          (candidate) => "askId" in parsed && candidate.askId === parsed.askId,
        );
        if (ask === undefined || !("askId" in parsed))
          throw new Error("Fixture expects an explicit question");
        if (!("stage" in parsed))
          return {
            type: "prompt",
            prompt: {
              type: "decision",
              message: ask.text,
              options: [
                { value: "Blue", label: "Blue", description: "Blue theme" },
                { value: "Green", label: "Green", description: "Green theme" },
                { value: "Teal", label: "Teal", description: "Teal theme" },
              ],
              multiple: ask.multiple,
              other: {
                label: "Other…",
                placeholder: "Write your own answer",
                maxLength: 4000,
              },
            },
            next: {
              arguments: {
                stage: "decision",
                askId: ask.askId,
                requestId: `request-${ask.askId}`,
                index: 0,
                answers: {},
              },
              answer: "answer",
            },
          };
        if (failAnswers)
          throw new Error("The service did not answer. Try again.");
        pending = pending.filter((candidate) => candidate.askId !== ask.askId);
        await publish();
        return {
          type: "done",
          notice: { type: "success", message: "Answer sent." },
        };
      },
    }),
  };
  return {
    session,
    calls,
    publish,
    failAnswers: (fail: boolean) => {
      failAnswers = fail;
    },
    ask: async (...which: FixtureAsk[]) => {
      pending = which;
      await publish();
    },
    answers: () =>
      calls.flatMap(([, input]) => (answered(input) ? [input.answer] : [])),
  };
}

export async function mount(
  width: number,
  height: number,
  theme: "mocha" | "latte" = "mocha",
  messages: SessionMessage[] = [],
) {
  notifyManager.setScheduler(queueMicrotask);
  const fixture = createTuiFixture({ messages });
  const question = questionSession(fixture);
  const commands = createWhistle();
  const query = createQueryClient();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        initialTheme={theme}
        session={question.session}
        clients={[questionClient]}
        commands={commands}
      />
    </QueryClientProvider>,
    { width, height, kittyKeyboard: true },
  );
  const frame = async (text: string) =>
    act(async () => setup.waitForFrame((value) => value.includes(text)));
  const gone = async (text: string) =>
    act(async () => setup.waitForFrame((value) => !value.includes(text)));
  const key = async (name: string, modifiers?: { meta?: boolean }) => {
    act(() => {
      setup.mockInput.pressKey(name, modifiers);
    });
    await act(async () => setup.renderOnce());
  };
  const type = async (text: string) => {
    await act(async () => setup.mockInput.typeText(text));
    await act(async () => setup.renderOnce());
  };
  const shot = async (name: string) => {
    const output = process.env.TUI_COMPOSER_Q_SHOTS;
    if (output === undefined) return;
    await mkdir(output, { recursive: true });
    await captureFrame(setup, output, name);
  };
  await act(async () => setup.renderOnce());
  return {
    setup,
    fixture,
    question,
    frame,
    gone,
    key,
    type,
    shot,
    close: async () => {
      await destroyTestRenderer(setup, () => {
        commands.close();
        query.clear();
      });
      await fixture.waitForClose();
      notifyManager.setScheduler(defaultScheduler);
    },
  };
}

/**
 * The same question session inside the terminal application, whose global
 * keymap sees Esc before any pane does.
 */
export async function mountInApplication() {
  const fixture = createTuiFixture();
  const question = questionSession(fixture);
  const setup = await testRender(<box />, { width: 100, height: 30 });
  const app = await openTerminalApplication({
    signals: { on: () => undefined, off: () => undefined },
    createQueryClient,
    createRenderer: () => Promise.resolve(setup.renderer),
    createRoot,
    createWhistle,
    enableKeymap: true,
  });
  if (app === undefined) throw new Error("Terminal did not open");
  app.inputHandoff?.pause();
  act(() => {
    renderTuiConversation(app.root, app.queryClient, {
      session: question.session,
      clients: [questionClient],
      commands: app.commands,
      commandHost: app.commandHost,
    });
  });
  await act(async () =>
    setup.waitForFrame((frame) => frame.includes("Ask anything")),
  );
  const key = async (name: string) => {
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey(name);
    });
  };
  return {
    setup,
    fixture,
    question,
    key,
    frame: async (text: string) =>
      act(async () => setup.waitForFrame((value) => value.includes(text))),
    close: async () => {
      await act(async () => app.close());
    },
  };
}
