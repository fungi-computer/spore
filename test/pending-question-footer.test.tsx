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
import type { ParakeetSession } from "@fungi.computer/parakeet/headless";
import type { SessionExtensionSlots } from "@fungi.computer/shiitake/client";
import type { Json } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import questionClient from "@fungi.computer/shiitake-extensions/question/client";
import {
  questionContract,
  AskProjection,
  AnswerFlowInput,
} from "@fungi.computer/shiitake-extensions/question";
import { sigilGutterText } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";

const idleStatus = `${sigilGutterText("●")}idle`;
const waitingStatus = `${sigilGutterText("●")}waiting on you`;
import { createTuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";

const asks = [
  { askId: "question-color", text: "Which color should we use?" },
  { askId: "question-storage", text: "Where should the notes live?" },
];
const baselineCapture = process.env.TUI_QUESTION_BASELINE === "1";
const encode = Schema.encodeSync(AskProjection);
const decode = Schema.decodeUnknownSync(AnswerFlowInput);

const sizes: readonly (readonly [number, number])[] = [
  [80, 24],
  [160, 48],
];
for (const [width, height] of sizes) {
  test(`pending questions expand the footer without stealing the draft (${String(width)}×${String(height)})`, async () => {
    notifyManager.setScheduler(queueMicrotask);
    const fixture = createTuiFixture();
    const declineResponse = Promise.withResolvers<undefined>();
    let pending: typeof asks = [];
    const calls: unknown[] = [];
    const slots = (): SessionExtensionSlots => ({
      [questionContract.id]: {
        status: "running",
        revision: `sha256:${pending.map((ask) => ask.askId).join("-")}`,
        value: encode({
          asks: pending.map((ask) => ({
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
                ],
              },
            ],
          })),
        }),
        catalog: {
          protocol: "whistle.catalog/v1",
          commands: [
            {
              id: "answerFlow",
              title: "Answer a question",
              category: "Conversation",
              projections: { slash: { aliases: ["answer"] } },
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
          if (!("askId" in parsed))
            throw new Error("Fixture expects an explicit selected question");
          if (!("stage" in parsed))
            return {
              type: "prompt",
              prompt: {
                type: "choice",
                message: "Choose your answer",
                options: [
                  { value: "Blue", label: "Blue" },
                  { value: "Green", label: "Green" },
                  { value: "Decline", label: "Decline" },
                ],
              },
              next: {
                arguments: {
                  stage: "selection",
                  askId: parsed.askId,
                  requestId: "question-fixture-request",
                  index: 0,
                  answers: {},
                },
                answer: "selection",
              },
            };
          pending = pending.filter((ask) => ask.askId !== parsed.askId);
          await publish();
          // The watch can withdraw an ask before its command response arrives.
          if ("selection" in parsed && parsed.selection === "Decline")
            await declineResponse.promise;
          return {
            type: "done",
            notice: {
              type: "success",
              message:
                "selection" in parsed && parsed.selection === "Decline"
                  ? "Question declined"
                  : "Question answered",
            },
          };
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
          clients={baselineCapture ? [] : [questionClient]}
          commands={commands}
        />
      </QueryClientProvider>,
      { width, height, kittyKeyboard: true },
    );
    const frame = async (text: string) =>
      act(async () => setup.waitForFrame((value) => value.includes(text)));
    const key = async (name: string, modifiers?: { meta?: boolean }) => {
      act(() => {
        setup.mockInput.pressKey(name, modifiers);
      });
      await act(async () => setup.renderOnce());
    };
    try {
      await act(async () => setup.renderOnce());
      await act(async () => setup.mockInput.typeText("Keep this draft"));
      await frame("Keep this draft");
      for (let i = 0; i < 5; i += 1) await key("ARROW_LEFT");
      await captureFrame(
        setup,
        process.env.TUI_QUESTION_CAPTURE_DIR,
        `idle-${String(width)}`,
      );
      const first = asks[0];
      if (first === undefined)
        throw new Error("Missing first question fixture");
      pending = [first];
      await act(publish);
      if (baselineCapture) {
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).not.toContain(
          "Which color should we use?",
        );
        await captureFrame(
          setup,
          process.env.TUI_QUESTION_CAPTURE_DIR,
          `automatic-${String(width)}`,
        );
        return;
      }
      await frame("Which color should we use?");
      const automatic = setup.captureCharFrame();
      expect(automatic.indexOf("Which color should we use?")).toBeGreaterThan(
        automatic.indexOf("Keep this draft"),
      );
      expect(automatic).toContain("Alt+↑");
      expect(automatic).toContain(waitingStatus);
      expect(automatic).not.toContain(idleStatus);
      await act(async () => setup.mockInput.typeText("live "));
      await frame("Keep this live draft");
      await key("END");
      await act(async () => setup.mockInput.typeText(" here"));
      await frame("Keep this live draft here");
      await captureFrame(
        setup,
        process.env.TUI_QUESTION_CAPTURE_DIR,
        `automatic-${String(width)}`,
      );
      pending = [...asks];
      await act(publish);
      await frame("1/2");
      expect(setup.captureCharFrame()).not.toContain(
        "Where should the notes live?",
      );
      await key("ARROW_UP", { meta: true });
      await frame("Esc back to draft");
      await key("ARROW_DOWN");
      await frame("Where should the notes live?");
      expect(setup.captureCharFrame()).toContain("2/2 · Where");
      expect(setup.captureCharFrame()).not.toContain("2 pending");
      await captureFrame(
        setup,
        process.env.TUI_QUESTION_CAPTURE_DIR,
        `focused-${String(width)}`,
      );
      await key("ARROW_DOWN", { meta: true });
      await frame("Alt+↑");
      await key("ARROW_UP", { meta: true });
      await frame("Esc back to draft");
      await key("ESCAPE");
      await frame("Alt+↑");
      await act(async () => setup.mockInput.typeText("!"));
      await frame("Keep this live draft here!");
      expect(fixture.cancelCalls()).toEqual([]);
      expect(calls).toEqual([]);
      await key("ARROW_UP", { meta: true });
      await frame("Esc back to draft");
      pending = [];
      await act(publish);
      await act(async () =>
        setup.waitForFrame((value) => value.includes(idleStatus)),
      );
      await act(async () => setup.mockInput.typeText("?"));
      await frame("Keep this live draft here!?");
      pending = [...asks];
      await act(publish);
      await frame("2/2");
      await key("ARROW_UP", { meta: true });
      await key("RETURN");
      await frame("Choose your answer");
      await captureFrame(
        setup,
        process.env.TUI_QUESTION_CAPTURE_DIR,
        `answer-picker-${String(width)}`,
      );
      await key("RETURN");
      await frame("Which color should we use?");
      await captureFrame(
        setup,
        process.env.TUI_QUESTION_CAPTURE_DIR,
        `answer-result-${String(width)}`,
      );
      expect(setup.captureCharFrame()).not.toContain("Enter close");
      expect(setup.captureCharFrame()).not.toContain("Choose your answer");
      expect(setup.captureCharFrame()).not.toContain("Question answered");
      expect(setup.captureCharFrame()).not.toContain(
        "Where should the notes live?",
      );
      const answer = commands
        .snapshot()
        .slash.find((row) => row.alias === "answer");
      if (answer === undefined) throw new Error("/answer missing");
      act(() => {
        void commands.execute(answer.commandId, {
          origin: "slash",
          arguments: { askId: "question-color" },
        });
      });
      await act(async () => setup.renderOnce());
      await frame("Choose your answer");
      await key("ARROW_DOWN");
      await key("ARROW_DOWN");
      await key("RETURN");
      const withdrawnFrame = await act(async () =>
        setup.waitForFrame(
          (value) => !value.includes("Which color should we use?"),
        ),
      );
      expect(withdrawnFrame).toContain("Answer a question");
      expect(withdrawnFrame).toContain("Esc cancel");
      await act(async () => {
        declineResponse.resolve(undefined);
        await setup.renderOnce();
      });
      // Finish React work before polling the native dialog's prompt/status view.
      const settledFrame = await setup.waitForFrame(
        (value) =>
          !value.includes("Which color should we use?") &&
          !value.includes("Choose your answer") &&
          !value.includes("Answer a question"),
      );
      expect(settledFrame).not.toContain("Enter close");
      expect(settledFrame).not.toContain("Answer a question");
      expect(settledFrame).not.toContain("Choose your answer");
      expect(settledFrame).not.toContain("Question declined");
      expect(settledFrame).toContain("Keep this live draft here!?");
      expect(settledFrame).toContain(idleStatus);
      expect(settledFrame).not.toContain("waiting on you");
      await captureFrame(
        setup,
        process.env.TUI_QUESTION_CAPTURE_DIR,
        `settled-${String(width)}`,
      );
      expect(calls).toHaveLength(4);
    } finally {
      declineResponse.resolve(undefined);
      await destroyTestRenderer(setup);
      commands.close();
      query.clear();
      await fixture.waitForClose();
      notifyManager.setScheduler(defaultScheduler);
    }
  });
}
