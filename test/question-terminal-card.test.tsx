import { expect, test } from "bun:test";
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
import { createParakeetInteractions } from "@fungi.computer/parakeet/headless";
import type { SessionExtensionSlots } from "@fungi.computer/shiitake/client";
import type { Json } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import questionClient from "@fungi.computer/shiitake-extensions/question/client";
import {
  AskProjection,
  questionContract,
} from "@fungi.computer/shiitake-extensions/question";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import {
  destroyTestRenderer,
  enterReactActEnvironment,
} from "./native-renderer-cleanup.js";

const question = "Which store should hold the notes?";
const encode = Schema.encodeSync(AskProjection);

test("terminal questions leave no passive, row-answer or slash-answer card", async () => {
  const leaveActEnvironment = enterReactActEnvironment();
  notifyManager.setScheduler(queueMicrotask);
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const interactions = createParakeetInteractions();
  const query = createQueryClient();
  let open = false;
  let askId = "";
  let calls = 0;
  let execution: Promise<unknown> | undefined;
  const slots = (): SessionExtensionSlots => ({
    [questionContract.id]: {
      status: "running",
      revision: open ? "sha256:open" : "sha256:closed",
      value: encode({
        asks: open
          ? [
              {
                askId,
                status: "parked",
                createdAt: 1,
                expiresAt: null,
                questions: [
                  {
                    id: "storage",
                    header: "Storage",
                    question,
                    options: [
                      { label: "SQLite", description: "On this computer" },
                      { label: "PostgreSQL", description: "Shared store" },
                    ],
                  },
                ],
              },
            ]
          : [],
      }),
      catalog: {
        protocol: "whistle.catalog/v1",
        commands: [
          {
            id: "answerFlow",
            title: "Answer a question",
            category: "Conversation",
            availability: open
              ? { status: "available" }
              : {
                  status: "unavailable",
                  reason: "There is no waiting question to answer.",
                },
            projections: { slash: { aliases: ["answer"], order: 5 } },
          },
        ],
      },
    },
  });
  const session: ParakeetSession = {
    ...fixture.session,
    watch: async (input) => {
      const watch = await fixture.session.watch(input);
      return {
        ...watch,
        snapshot: { ...watch.snapshot, extensions: slots() },
      };
    },
    extension: () => ({
      call: (): Promise<Json> => {
        calls += 1;
        return Promise.resolve({
          type: "prompt",
          prompt: {
            type: "choice",
            message: question,
            options: [
              { value: "SQLite", label: "SQLite" },
              { value: "PostgreSQL", label: "PostgreSQL" },
            ],
          },
          next: {
            arguments: {
              askId,
              stage: "selection",
              requestId: "answer-storage",
              index: 0,
              answers: {},
            },
            answer: "selection",
          },
        });
      },
    }),
  };
  const publish = async () => {
    const snapshot = await fixture.session.read();
    fixture.pushFrame({
      kind: "update",
      delivery: "live",
      cursor: snapshot.cursor,
      messages: [],
      terminals: [],
      activity: snapshot.activity,
      pending: snapshot.pending,
      attention: [],
      extensions: slots(),
    });
  };
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        initialTheme="mocha"
        session={session}
        clients={[questionClient]}
        commands={commands}
        interactionStore={interactions}
      />
    </QueryClientProvider>,
    { width: 100, height: 30, kittyKeyboard: true },
  );
  try {
    await act(async () => setup.renderOnce());
    await act(async () => setup.mockInput.typeText("Keep this draft"));
    for (const admission of ["passive", "row", "slash", "implicit-slash"]) {
      open = true;
      askId = `ask-storage-${admission}`;
      calls = 0;
      await act(publish);
      await act(async () =>
        setup.waitForFrame((value) => value.includes(question)),
      );
      if (admission !== "passive") {
        if (admission === "row") {
          act(() => {
            setup.mockInput.pressKey("ARROW_UP", { meta: true });
          });
          await act(async () => setup.renderOnce());
          act(() => {
            setup.mockInput.pressKey("RETURN");
          });
        } else {
          const answer = commands
            .snapshot()
            .slash.find((row) => row.alias === "answer");
          if (answer === undefined) throw new Error("Missing /answer");
          act(() => {
            execution = commands.execute(answer.commandId, {
              origin: "slash",
              arguments: admission === "slash" ? { askId } : {},
            });
          });
        }
        await act(async () => setup.renderOnce());
        await act(async () =>
          setup.waitForFrame((value) => value.includes("Esc cancel")),
        );
        expect(calls).toBe(1);
      }
      open = false;
      await act(async () => {
        await publish();
        await setup.renderOnce();
      });
      const settled = await act(async () =>
        setup.waitForFrame(
          (value) =>
            !value.includes(question) && !value.includes("Answer a question"),
        ),
      );
      expect(settled).toContain("Keep this draft");
      expect(settled).not.toContain("waiting on you");
      expect(fixture.cancelCalls()).toEqual([]);
      expect(calls).toBe(admission === "passive" ? 0 : 1);
      await execution;
    }
  } finally {
    await destroyTestRenderer(setup, () => {
      interactions.close();
      commands.close();
      query.clear();
    });
    await execution;
    await fixture.waitForClose();
    notifyManager.setScheduler(defaultScheduler);
    leaveActEnvironment();
  }
});
