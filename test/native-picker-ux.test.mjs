import { executeAlias } from "./command-selection.js";
import assert from "node:assert/strict";
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { InputRenderable, TextareaRenderable } from "@opentui/core";
import { act } from "react";
import { createWhistle } from "@fungi.computer/whistle";

import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { createTuiFixture } from "./fixture.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { configuredModelAccess } from "./model-access-fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

function renderedNodes(node) {
  return [node, ...node.getChildren().flatMap(renderedNodes)];
}

async function captureSurface(name, setup) {
  const directory = process.env.TUI_UX_CAPTURE_DIR;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${name}.txt`, setup.captureCharFrame());
  const spans = setup.captureSpans();
  await writeFile(
    `${directory}/${name}.spans.json`,
    JSON.stringify(
      {
        ...spans,
        lines: spans.lines.map((line) => ({
          spans: line.spans.map((span) => ({
            ...span,
            fg: span.fg.toInts(),
            bg: span.bg.toInts(),
          })),
        })),
      },
      null,
      2,
    ),
  );
}

async function withCli(
  check,
  { listModels, runAuth, saveThemePreference } = {},
) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const fixture = createTuiFixture();
  const setup = await createTestRenderer({
    width: 96,
    height: 28,
    useKittyKeyboard: null,
  });
  const commands = createWhistle();
  let preference = null;
  const session = {
    ...fixture.session,
    modelPreference: {
      read: async () => preference,
      set: async (value) => {
        preference = value;
      },
    },
  };
  let hostCloses = 0;
  let running;
  const ready = Promise.withResolvers();
  try {
    await act(async () => {
      running = runTuiCli(
        { invocationRoot: "/tmp" },
        {
          loadThemePreference: async () => ({ theme: "terminal" }),
          saveThemePreference: saveThemePreference ?? (async () => undefined),
          prepareClientExtensions: noOpClientExtensions,
          createServiceManager: () => ({
            status: async () => undefined,
            start: async () => ({
              serviceId: "fixture",
              baseUrl: "http://fixture",
            }),
            stop: async () => undefined,
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
            models: async () => listModels?.() ?? [],
            auth: async (request, interaction) => {
              if (request.command === "status")
                return configuredModelAccess(listModels?.() ?? []);
              if (!runAuth) throw new Error("Unexpected auth mutation");
              return runAuth(request, interaction);
            },
            createSession: async () => ({
              sandboxStatus: async () => ({
                mode: "full-access",
                available: true,
              }),
              ...fixture.identity,
              databasePath: "/fixture/main.sqlite",
              session,
              close: async () => {
                hostCloses += 1;
              },
            }),
            connect: async () => ({
              sandboxStatus: async () => ({
                mode: "full-access",
                available: true,
              }),
              ...fixture.identity,
              databasePath: "/fixture/main.sqlite",
              session,
              close: async () => {
                hostCloses += 1;
              },
            }),
          }),
          createWhistle: () => commands,
          enableKeymap: true,
          createRenderer: async () => {
            ready.resolve();
            return setup.renderer;
          },
        },
      );
      await Promise.race([ready.promise, running]);
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.waitForFrame((frame) =>
        frame.includes("Start a conversation."),
      );
    });
    await check({ fixture, setup, commands });
  } finally {
    if (hostCloses === 0)
      await act(async () => {
        await commands.execute(
          { namespace: "tui", id: "exit" },
          { origin: "slash" },
        );
      });
    await act(async () => {
      await running;
    });
    const destroyed = setup.renderer.isDestroyed;
    if (!destroyed) setup.renderer.destroy();
    assert.equal(destroyed, true, "application closes the renderer");
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
  await fixture.waitForClose();
  assert.equal(hostCloses, 1);
  assert.equal(setup.renderer.listenerCount("resize"), 0);
  assert.deepEqual(
    await commands.execute(
      { namespace: "retired", id: "command" },
      { origin: "slash" },
    ),
    {
      status: "closed",
    },
  );
}

test("the native command palette fuzzily selects Theme through its real Whistle owner", async () => {
  await withCli(async ({ setup, fixture }) => {
    await pressDecodedKey(setup, () =>
      setup.mockInput.pressKey("k", { ctrl: true }),
    );
    await waitForFrame(setup, (frame) => frame.includes("Open pane"));
    await pressDecodedKey(setup, () =>
      setup.mockInput.pressKey("k", { ctrl: true }),
    );
    await waitForFrame(setup, (frame) => frame.includes("Commands"));
    for (const key of ["t", "h", "m"])
      await pressDecodedKey(setup, () => setup.mockInput.pressKey(key));
    assert.match(setup.captureCharFrame(), /▶ Theme/u);
    const line = setup.captureSpans().lines.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes("▶ Theme"),
    );
    assert.equal(
      line?.spans
        .filter((span) => (span.attributes & 1) !== 0)
        .map((span) => span.text)
        .join(""),
      "Thm",
    );
    await captureSurface("fuzzy-command-palette", setup);
    await pressDecodedKey(setup, () => setup.mockInput.pressEnter());
    await waitForFrame(setup, (frame) => frame.includes("↑↓ preview"));
    assert.equal(fixture.promptCalls(), 0);
    await pressDecodedKey(setup, () => setup.mockInput.pressEscape());
  });
});

test("the searchable /model choice keeps the draft and restores composer focus on Escape", async () => {
  const models = [
    { id: "gpt-5.6-sol", name: "Sol" },
    { id: "astra-2", name: "Astra" },
    { id: "cedar-1", name: "Cedar" },
    { id: "luna-3", name: "Luna" },
    { id: "fern-1", name: "Fern" },
    { id: "moss-2", name: "Moss" },
    // Seven actual models keep this above the shared picker's search threshold;
    // the provider's model list no longer includes an inheritance/reset row.
    { id: "oak-1", name: "Oak" },
  ];
  await withCli(
    async ({ setup, commands, fixture }) => {
      const editor = renderedNodes(setup.renderer.root).find(
        (node) => node instanceof TextareaRenderable,
      );
      assert.ok(editor);
      await act(async () =>
        setup.mockInput.typeText("draft before model picker"),
      );
      await act(async () => setup.renderOnce());
      assert.equal(editor.plainText, "draft before model picker");

      let choosing;
      await act(async () => {
        choosing = executeAlias(commands, "model", { origin: "slash" });
        await delay(10);
      });
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /SIGNED IN/u);
      assert.match(setup.captureCharFrame(), /DEFAULT/u);
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      const search = renderedNodes(setup.renderer.root).find(
        (node) => node instanceof InputRenderable,
      );
      assert.ok(search);
      assert.equal(search.focused, true);
      assert.equal(editor.focused, false);
      assert.match(setup.captureCharFrame(), /Sol/u);
      assert.match(setup.captureCharFrame(), /Cedar/u);
      assert.match(setup.captureCharFrame(), /Luna/u);
      await captureSurface("model", setup);
      await act(async () => setup.resize(48, 8));
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /Choose a model/u);
      assert.match(setup.captureCharFrame(), /Enter · Esc/u);
      await captureSurface("model-compact", setup);
      await act(async () => setup.resize(96, 28));
      await act(async () => setup.renderOnce());

      await act(async () => setup.mockInput.typeText("astra"));
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /▶ .*Astra/u);
      assert.doesNotMatch(setup.captureCharFrame(), /Cedar/u);
      assert.equal(fixture.promptCalls(), 0);

      await act(async () => {
        setup.mockInput.pressEscape();
        // A standalone ESC uses OpenTUI's native 20ms ambiguity window.
        await delay(25);
      });
      await act(async () => choosing);
      await act(async () => setup.renderOnce());
      assert.equal(editor.focused, true);
      assert.equal(editor.plainText, "draft before model picker");
      assert.equal(fixture.promptCalls(), 0);
    },
    {
      listModels: () =>
        models.map((model) => ({
          ...model,
          providerId: "fixture",
          providerName: "Fixture",
          reasoning: ["low"],
        })),
    },
  );
});

test("login's provider choice consumes input and Ctrl+C dismisses without auth or exit", async () => {
  const actions = [];
  await withCli(
    async ({ setup, commands, fixture }) => {
      const editor = renderedNodes(setup.renderer.root).find(
        (node) => node instanceof TextareaRenderable,
      );
      assert.ok(editor);
      await act(async () => {
        void commands.execute(
          { namespace: "account", id: "login" },
          { origin: "slash" },
        );
        await delay(25);
      });
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /Sign in to a model provider/u);
      assert.equal(editor.focused, false);
      await captureSurface("account", setup);
      await act(async () => setup.mockInput.typeText("sentinel"));
      await act(async () => setup.renderOnce());
      assert.equal(editor.plainText, "");
      await act(async () => {
        setup.mockInput.pressKey("c", { ctrl: true });
        await delay(0);
      });
      await act(async () => setup.renderOnce());
      assert.equal(editor.focused, true);
      assert.equal(actions.length, 0);
      assert.equal(setup.renderer.isDestroyed, false);
      assert.equal(fixture.promptCalls(), 0);
    },
    {
      runAuth: async (action) => {
        actions.push(action);
        return { kind: "completed" };
      },
    },
  );
});

test("login provider and method each commit on one number key; success closes", async () => {
  const actions = [];
  await withCli(
    async ({ setup, commands }) => {
      let choosing;
      await act(async () => {
        choosing = commands.execute(
          { namespace: "account", id: "login" },
          { origin: "slash" },
        );
        await delay(25);
      });
      await act(async () => setup.renderOnce());
      await captureSurface("login-provider-before-pick", setup);
      await act(async () => setup.mockInput.typeText("2"));
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /How do you want to sign in/u);
      await captureSurface("login-method-before-pick", setup);
      await act(async () => setup.mockInput.typeText("1"));
      await act(async () => choosing);
      await act(async () => setup.renderOnce());
      assert.equal(actions.length, 1);
      assert.doesNotMatch(setup.captureCharFrame(), /Enter close/u);
      assert.doesNotMatch(setup.captureCharFrame(), /Signed in to OpenAI/u);
      assert.doesNotMatch(
        setup.captureCharFrame(),
        /How do you want to sign in/u,
      );
      await captureSurface("login-submitted", setup);
    },
    {
      runAuth: async (action) => {
        actions.push(action);
        return { kind: "completed" };
      },
    },
  );
});

test("model provider and model each commit on one number key", async () => {
  await withCli(
    async ({ setup, commands }) => {
      await waitForFrame(setup, () =>
        commands
          .snapshot()
          .agent.some(
            (row) =>
              row.title === "Model" &&
              JSON.stringify(row.action ?? {}).includes("Fixture · Sol"),
          ),
      );
      let choosing;
      await act(async () => {
        choosing = executeAlias(commands, "model", { origin: "slash" });
        await delay(25);
      });
      await act(async () => setup.renderOnce());
      await act(async () => setup.mockInput.typeText("3"));
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /Sol/u);
      await captureSurface("model-before-pick", setup);
      await act(async () => setup.mockInput.typeText("1"));
      await act(async () => choosing);
      await act(async () => setup.renderOnce());
      assert.doesNotMatch(setup.captureCharFrame(), /Enter close/u);
      assert.doesNotMatch(setup.captureCharFrame(), /Use agent model/u);
      await captureSurface("model-submitted", setup);
    },
    {
      listModels: () => [
        {
          id: "sol",
          name: "Sol",
          providerId: "fixture",
          providerName: "Fixture",
          reasoning: [],
        },
      ],
    },
  );
});

test("switching an already signed-in account closes success without Enter or Esc", async () => {
  const actions = [];
  await withCli(
    async ({ setup, commands }) => {
      let choosing;
      await act(async () => {
        choosing = commands.execute(
          { namespace: "account", id: "login" },
          { origin: "slash" },
        );
        await delay(25);
      });
      await act(async () => setup.renderOnce());
      await act(async () => setup.mockInput.typeText("1"));
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /Switch account/u);
      await captureSurface("switch-account-before-pick", setup);
      await act(async () => setup.mockInput.typeText("1"));
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /How do you want to sign in/u);
      await act(async () => setup.mockInput.typeText("1"));
      await act(async () => choosing);
      await act(async () => setup.renderOnce());
      assert.equal(actions.length, 1);
      assert.doesNotMatch(setup.captureCharFrame(), /Signed in to OpenAI/u);
      assert.doesNotMatch(
        setup.captureCharFrame(),
        /How do you want to sign in|Switch account/u,
      );
      assert.doesNotMatch(setup.captureCharFrame(), /Enter close/u);
      await captureSurface("switch-account-submitted", setup);
    },
    {
      listModels: () => [
        {
          id: "sol",
          name: "Sol",
          providerId: "openai",
          providerName: "OpenAI",
          reasoning: [],
        },
      ],
      runAuth: async (action) => {
        actions.push(action);
        return { kind: "completed" };
      },
    },
  );
});

test("slash completion shows the real Whistle choice and Enter opens theme without a prompt", async () => {
  await withCli(async ({ setup, fixture }) => {
    await act(async () => setup.mockInput.typeText("/the"));
    await act(async () => setup.renderOnce());
    assert.match(setup.captureCharFrame(), /\/theme\s+Choose terminal colors/u);
    await act(async () => {
      setup.mockInput.pressEnter();
      await delay(0);
    });
    await act(async () => setup.renderOnce());
    assert.match(setup.captureCharFrame(), /↑↓ preview · Enter save/u);
    await captureSurface("theme", setup);
    assert.equal(fixture.promptCalls(), 0);
    const editor = renderedNodes(setup.renderer.root).find(
      (node) => node instanceof TextareaRenderable,
    );
    assert.ok(editor);
    assert.equal(editor.plainText, "");
    await act(async () => {
      setup.mockInput.pressEscape();
      await delay(25);
    });
    await act(async () => setup.renderOnce());
    assert.equal(editor.focused, true);
  });
});

test("a numbered theme pick saves that theme, not the previously highlighted one", async () => {
  const saved = [];
  await withCli(
    async ({ setup, commands }) => {
      await act(async () => {
        await executeAlias(commands, "theme", { origin: "slash" });
      });
      await act(async () => setup.renderOnce());
      await setup.waitForFrame((frame) => frame.includes("↑↓ preview"));
      await act(async () => setup.mockInput.typeText("3"));
      await setup.waitForFrame((frame) => !frame.includes("↑↓ preview"));
      assert.deepEqual(saved, ["latte"]);
    },
    { saveThemePreference: async (theme) => saved.push(theme) },
  );
});
