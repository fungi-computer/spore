import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "bun:test";
import { act } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";
import {
  completeSlash,
  slashRegistry,
} from "@fungi.computer/parakeet/headless";
import {
  slashParityCases,
  slashParityFlow,
} from "@fungi.computer/parakeet-testing";
import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { renderTuiConversation } from "@fungi.computer/spore/frame-renderer";
import { createTuiFixture } from "./fixture.js";
import { slashRows } from "@fungi.computer/spore/button/slash-completion";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

async function capture(setup, name) {
  const directory = process.env.TUI_UX_CAPTURE_DIR;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${name}.txt`, setup.captureCharFrame());
  const spans = setup.captureSpans();
  await writeFile(
    `${directory}/${name}.spans.json`,
    JSON.stringify({
      ...spans,
      lines: spans.lines.map((line) => ({
        spans: line.spans.map((span) => ({
          ...span,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
        })),
      })),
    }),
  );
}

async function withGarden(check, { garden = true } = {}) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const fixture = createTuiFixture({ garden });
  const setup = await createTestRenderer({
    width: 80,
    height: 30,
    useKittyKeyboard: null,
  });
  const commands = createWhistle();
  let running;
  const ready = Promise.withResolvers();
  try {
    await act(async () => {
      running = runTuiCli(
        { invocationRoot: "/tmp" },
        {
          loadThemePreference: async () => ({ theme: "mocha" }),
          saveThemePreference: async () => undefined,
          prepareClientExtensions: noOpClientExtensions,
          createServiceManager: () => ({
            discover: async () => ({
              agents: [
                {
                  agentId: "one",
                  databasePath: "/project/one/agent.sqlite",
                  sessionCount: 1,
                },
              ],
              sessions: [],
              problems: [],
            }),
            models: async () => [],
            auth: async () => undefined,
            connect: async () => ({
              sandboxStatus: async () => ({
                state: "available",
                requireSandbox: false,
              }),
              ...fixture.identity,
              databasePath: "/tmp/garden.sqlite",
              session: {
                ...fixture.session,
                modelPreference: {
                  read: async () => null,
                  set: async () => undefined,
                },
              },
              close: async () => undefined,
            }),
          }),
          createWhistle: () => commands,
          enableKeymap: true,
          createRenderer: async () => setup.renderer,
          render: (
            root,
            queryClient,
            session,
            frameCommands,
            onExit,
            theme,
            controls,
          ) => {
            renderTuiConversation(root, queryClient, {
              ...theme,
              commands: frameCommands,
              onExit,
              session,
              ...controls,
            });
            ready.resolve();
          },
        },
      );
      await Promise.race([ready.promise, running]);
    });
    await setup.waitForFrame((frame) => frame.includes("Ask anything"));
    const type = async (text) => {
      await act(async () => setup.mockInput.pressKey("u", { ctrl: true }));
      await act(async () => setup.mockInput.typeText(text));
      await act(async () => setup.renderOnce());
    };
    const settle = async () => {
      await act(async () => delay(10));
      await act(async () => setup.renderOnce());
    };
    await check({ setup, commands, fixture, type, settle });
  } finally {
    await act(async () => commands.execute("tui:exit", { origin: "slash" }));
    await act(async () => running);
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

/** The labels the terminal drew for the completion, top to bottom. */
function drawnLabels(frame, labels) {
  return frame
    .split("\n")
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter((word) => labels.includes(word));
}

test("the terminal draws exactly Parakeet's completion for every parity draft", async () => {
  await withGarden(async ({ setup, commands, type }) => {
    for (const { draft, rows } of slashParityCases) {
      await type(draft);
      const expected = slashRows(
        completeSlash(slashRegistry(commands.snapshot()), draft),
      ).map((row) => row.label);
      // The garden rows the parity case names are all there, in order.
      assert.deepEqual(
        expected.filter((label) => rows.includes(label)),
        rows.filter((label) => expected.includes(label)),
        draft,
      );
      if (draft === "/water " || draft === "/wtr")
        assert.deepEqual(expected, rows, draft);
      const visible = expected.slice(0, 6);
      assert.deepEqual(
        drawnLabels(setup.captureCharFrame(), visible),
        visible,
        draft,
      );
    }
    await type("/");
    assert.doesNotMatch(
      setup.captureCharFrame(),
      /\/(?:retry|continue|cancel|pane-close|pane-open|row-actions|session)\b/u,
    );
    assert.match(setup.captureCharFrame(), /More…/u);
    for (const alias of ["help", "login", "model"])
      assert.ok(setup.captureCharFrame().includes(`/${alias} `));
    await capture(setup, "slash-all");
    await type("/water ");
    assert.match(setup.captureCharFrame(), /\/water <bed> \| all/u);
    // The footer projects no completion key hints.
    assert.doesNotMatch(
      setup.captureCharFrame(),
      /Esc dismiss prompt|Tab complete|Enter run/u,
    );
  });
});

test("an advertised command appears mid-Session and runs its flow in the terminal", async () => {
  await withGarden(
    async ({ setup, fixture, type, settle }) => {
      await type("/wat");
      assert.doesNotMatch(setup.captureCharFrame(), /\/water/u);
      await act(async () => fixture.advertiseGarden());
      await settle();
      await type("/wat");
      assert.match(
        setup.captureCharFrame(),
        /\/water\s+Water one bed, or every bed at once/u,
      );
      await capture(setup, "slash-menu");
      await act(async () => setup.mockInput.pressTab());
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /› \/water /u);
      await type(slashParityFlow.draft);
      await act(async () => setup.mockInput.pressEnter());
      await settle();
      assert.match(
        setup.captureCharFrame(),
        new RegExp(slashParityFlow.prompt, "u"),
      );
      assert.match(
        setup.captureCharFrame(),
        new RegExp(slashParityFlow.choose, "u"),
      );
      await capture(setup, "slash-flow");
      await act(async () => setup.mockInput.pressEnter());
      await settle();
      assert.doesNotMatch(
        setup.captureCharFrame(),
        new RegExp(slashParityFlow.notice, "u"),
      );
      assert.doesNotMatch(setup.captureCharFrame(), /Which bed/u);
      assert.equal(fixture.promptCalls(), 0);
    },
    { garden: false },
  );
});
