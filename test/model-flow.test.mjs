import { createQueryClient } from "@fungi.computer/agar/query";
import { waitForFrame } from "./native-readiness.js";
import { executeAlias } from "./command-selection.js";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "bun:test";
import { act } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import { createWhistle } from "@fungi.computer/whistle";
import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { createTuiFixture } from "./fixture.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { configuredModelAccess, modelHistory } from "./model-access-fixture.js";

const models = [
  {
    providerId: "openai",
    providerName: "OpenAI",
    id: "sol",
    name: "Sol",
    reasoning: ["high"],
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    id: "luna",
    name: "Luna",
    reasoning: ["low", "medium"],
  },
];
function nodes(node) {
  return [node, ...node.getChildren().flatMap(nodes)];
}
function assertOptions(setup, labels) {
  assert.equal(
    nodes(setup.renderer.root).filter((node) => node.id.startsWith("choice-"))
      .length,
    labels.length,
  );
  const frame = setup.captureCharFrame();
  let previous = -1;
  for (const label of labels) {
    const position = frame.indexOf(label);
    assert.ok(
      position > previous,
      `Expected visible choice in order: ${label}`,
    );
    previous = position;
  }
}
async function press(setup, key) {
  await act(async () => {
    if (key === "enter") setup.mockInput.pressEnter();
    else if (key === "escape") {
      setup.mockInput.pressEscape();
      await delay(25);
    } else setup.mockInput.pressArrow(key);
  });
  await act(async () => setup.renderOnce());
}
async function capture(setup, name) {
  const directory = process.env.TUI_UX_CAPTURE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${name}.txt`, setup.captureCharFrame());
  const frame = setup.captureSpans();
  await writeFile(
    `${directory}/${name}.spans.json`,
    JSON.stringify(
      {
        ...frame,
        lines: frame.lines.map((line) => ({
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

// Native frame/keymap and real CLI transition; the Session/model transport is a fixture.
async function withModels(
  check,
  {
    listModels = () => models,
    beforeSave = async () => undefined,
    beforeExtensionsComplete,
    auth = async () => configuredModelAccess(listModels()),
  } = {},
) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const opened = [];
  const archived = [];
  const setups = [];
  const fixtures = [];
  const commandOwners = [];
  const ready = [Promise.withResolvers()];
  let preference = {
    providerId: "openai",
    modelId: "sol",
    reasoning: "high",
  };
  let closed = 0;
  let running;
  const queryClient = createQueryClient();
  queryClient.setQueryDefaults(["tui-model-catalog"], {
    initialData: listModels(),
  });
  try {
    await act(async () => {
      running = runTuiCli(
        { invocationRoot: "/fixture", databasePath: "/fixture/main.sqlite" },
        {
          createQueryClient: () => queryClient,
          loadThemePreference: async () => ({ theme: "terminal" }),
          saveThemePreference: async () => undefined,
          prepareClientExtensions: noOpClientExtensions,
          createServiceManager: () => {
            const fixture = createTuiFixture({
              messages: modelHistory("openai", "gpt-6-astra"),
            });
            fixtures.push(fixture);
            return {
              stop: async () => {
                throw new Error("client cannot stop service");
              },
              archive: async (request) => {
                archived.push(request);
              },
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
              models: async () => listModels(),
              auth,
              connect: async () => {
                opened.push({ modelId: "sol", reasoning: "high" });
                return {
                  agentId: "agent-fixture",
                  databasePath: "/fixture/main.sqlite",
                  sessionId: "main",
                  sandboxStatus: async () => ({
                    state: "available",
                    requireSandbox: false,
                  }),
                  effectiveModel: async () => {
                    const selected = preference?.modelId ?? "sol";
                    const name = selected === "luna" ? "Luna" : "Sol";
                    return {
                      agentName: "Shiitake",
                      providerId: "openai",
                      providerName: "OpenAI",
                      modelId: selected,
                      modelName: name,
                      credential: { kind: "oauth", source: "OpenAI login" },
                      label: `Shiitake · ${name} (${preference?.reasoning ?? "medium"}) · OpenAI login`,
                    };
                  },
                  session: {
                    ...fixture.session,
                    modelPreference: {
                      read: async () => preference,
                      set: async (value) => {
                        await beforeSave(value);
                        preference = value;
                      },
                    },
                  },
                  close: async () => {
                    closed += 1;
                  },
                };
              },
            };
          },
          createWhistle: () => {
            const runtime = createWhistle();
            const commands = {
              ...runtime,
              contribute: (contribution) =>
                runtime.contribute(
                  beforeExtensionsComplete === undefined
                    ? contribution
                    : {
                        ...contribution,
                        commands: contribution.commands.map((command) =>
                          command.id !== "extensions"
                            ? command
                            : {
                                ...command,
                                handler: async (input) => {
                                  const result = await command.handler(input);
                                  // Hold the real handler after its notice but
                                  // before Whistle settles its flow surface.
                                  await beforeExtensionsComplete();
                                  return result;
                                },
                              },
                        ),
                      },
                ),
            };
            commandOwners.push(commands);
            return commands;
          },
          createRenderer: async () => {
            const setup = await createTestRenderer({
              width: 96,
              height: 28,
              useKittyKeyboard: null,
            });
            setups.push(setup);
            ready[0].resolve();
            return setup.renderer;
          },
          enableKeymap: true,
        },
      );
      await Promise.race([ready[0].promise, running]);
    });
    await waitForFrame(setups[0], () =>
      queryClient
        .getQueryCache()
        .findAll({
          predicate: (query) => query.queryKey[0] === "tui-model-catalog",
        })
        .some((query) => query.state.status === "success"),
    );
    await check({
      setups,
      commandOwners,
      opened,
      archived,
      ready,
      get closed() {
        return closed;
      },
    });
  } finally {
    await act(async () => {
      await commandOwners.at(-1)?.execute("tui:exit", { origin: "slash" });
      await running;
    });
    for (const setup of setups) {
      const destroyed = setup.renderer.isDestroyed;
      if (!destroyed) setup.renderer.destroy();
      assert.equal(destroyed, true, "application closes the renderer");
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
  for (const fixture of fixtures) {
    await fixture.waitForClose();
    assert.equal(fixture.promptCalls(), 0);
  }
  assert.equal(closed, opened.length);
  for (const setup of setups)
    assert.equal(setup.renderer.listenerCount("resize"), 0);
}

/** Start a command whose flow waits for answers, and let its first prompt draw. */
async function begin(setup, owner, commandId) {
  let running;
  await act(async () => {
    running = executeAlias(owner, commandId, { origin: "slash" });
    await delay(10);
  });
  await act(async () => setup.renderOnce());
  // Wrapped, so awaiting `begin` does not wait for the whole flow.
  return { settled: () => running };
}

for (const [alias, title] of [
  ["archive", "Archive an Agent"],
  ["extensions", "Manage extensions"],
]) {
  test(`${alias} is discoverable through command search and slash commands`, async () => {
    const closing = Promise.withResolvers();
    const releaseClose = Promise.withResolvers();
    let observedClosing = false;
    try {
      await withModels(
        async ({ setups, commandOwners, archived }) => {
          const setup = setups[0];
          await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
          await act(async () => setup.mockInput.pressKey("k", { ctrl: true }));
          await act(async () => setup.renderOnce());
          await act(async () => setup.mockInput.typeText(":"));
          await act(async () => setup.renderOnce());
          await act(async () => setup.mockInput.typeText(alias));
          await act(async () => setup.renderOnce());
          await capture(setup, `${alias}-discovery`);
          assert.match(setup.captureCharFrame(), new RegExp(title, "u"));
          assert.ok(
            commandOwners[0]
              .snapshot()
              .slash.some((row) => row.alias === alias),
          );
          await press(setup, "escape");
          await act(async () => setup.mockInput.typeText(`/${alias}`));
          await press(setup, "enter");
          if (alias === "archive") {
            await waitForFrame(setup, (frame) =>
              frame.includes("Archive which Agent?"),
            );
            await capture(setup, "09-archive-agents");
            await press(setup, "enter");
            await waitForFrame(setup, (frame) =>
              frame.includes("conversations and files stay"),
            );
            await press(setup, "enter");
            await waitForFrame(setup, () => archived.length === 1);
            assert.deepEqual(archived, [
              {
                invocationRoot: "/fixture",
                agentId: "one",
                archived: true,
              },
            ]);
          } else {
            await waitForFrame(setup, (frame) => frame.includes("Extensions"));
            await capture(setup, "10-extensions");
            await press(setup, "enter");
            await act(async () => closing.promise);
            await waitForFrame(setup, (frame) => {
              const ready =
                frame.includes("No extensions installed.") &&
                !frame.includes("Manage extensions") &&
                !frame.includes("Enter close");
              if (
                !observedClosing &&
                frame.includes("No extensions installed.")
              ) {
                observedClosing = true;
                try {
                  assert.match(frame, /Manage extensions/u);
                  assert.equal(
                    ready,
                    false,
                    "the notice cannot make the still-closing dialog ready",
                  );
                } finally {
                  releaseClose.resolve();
                }
              }
              return ready;
            });
            assert.equal(observedClosing, true);
            assert.doesNotMatch(setup.captureCharFrame(), /Manage extensions/u);
            assert.doesNotMatch(setup.captureCharFrame(), /Enter close/u);
            await capture(setup, "11-extensions-list");
          }
        },
        {
          beforeExtensionsComplete:
            alias === "extensions"
              ? async () => {
                  closing.resolve();
                  await releaseClose.promise;
                }
              : undefined,
        },
      );
    } finally {
      releaseClose.resolve();
    }
  });
}

test("cancelled /model consumes only its command", async () => {
  await withModels(async ({ setups, commandOwners }) => {
    const setup = setups[0];
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
    await act(async () => setup.mockInput.typeText("/model"));
    await press(setup, "enter");
    await waitForFrame(setup, (frame) => frame.includes("Use agent model"));
    await press(setup, "escape");
    await act(async () => setup.mockInput.typeText("next prompt"));
    await act(async () => setup.renderOnce());
    await capture(setup, "02-cancelled-model");
    assert.doesNotMatch(setup.captureCharFrame(), /\/modelnext prompt/u);
    assert.match(setup.captureCharFrame(), /next prompt/u);
    // A command-search launch preserves a genuine pre-existing draft.
    const choosing = await begin(setup, commandOwners[0], "model");
    await press(setup, "escape");
    await choosing.settled();
    assert.match(setup.captureCharFrame(), /next prompt/u);
  });
});

test("provider Enter keeps that provider instead of resetting to the agent model", async () => {
  await withModels(async ({ setups, commandOwners }) => {
    const setup = setups[0];
    const provider = await begin(setup, commandOwners[0], "model");
    await press(setup, "down");
    await press(setup, "down");
    await press(setup, "enter");
    await capture(setup, "05-provider-default");
    try {
      assert.match(setup.captureCharFrame(), /▶ OpenAI · Sol \(current\)/u);
      await press(setup, "enter");
      assert.match(setup.captureCharFrame(), /Thinking level for Sol/u);
      await press(setup, "enter");
      await provider.settled();
      assert.match(setup.captureCharFrame(), /openai\/sol/u);
    } finally {
      await press(setup, "escape");
      await provider.settled();
    }
  });
});

test("native model flow applies one supported pair only after the thinking choice", async () => {
  await withModels(async ({ setups, commandOwners, opened }) => {
    const setup = setups[0];
    const choosing = await begin(setup, commandOwners[0], "model");
    assert.match(setup.captureCharFrame(), /Model/u);
    assertOptions(setup, ["Use agent model", "Fungi", "OpenAI"]);
    await press(setup, "down");
    await press(setup, "down");
    await press(setup, "enter");
    assertOptions(setup, ["OpenAI · Sol (current)", "OpenAI · Luna"]);
    await press(setup, "down");
    await press(setup, "enter");
    assert.match(setup.captureCharFrame(), /Thinking level for Luna/u);
    assertOptions(setup, ["Model default", "low", "medium"]);
    assert.equal(
      opened.length,
      1,
      "model choice alone does not replace the host",
    );
    await capture(setup, "thinking");
    await act(async () => setup.resize(48, 8));
    await act(async () => setup.renderOnce());
    assert.match(setup.captureCharFrame(), /Thinking level for Luna/u);
    await capture(setup, "thinking-compact");
    await act(async () => setup.resize(96, 28));
    await press(setup, "down");
    assert.match(setup.captureCharFrame(), /▶ low/u);
    await act(async () => {
      setup.mockInput.pressEnter();
      await delay(25);
    });
    await act(async () => choosing.settled());
    assert.equal(
      setup.renderer.isDestroyed,
      false,
      "changing the model must not leave the terminal alternate screen",
    );
    assert.equal(
      setups.length,
      1,
      "one renderer owns the complete CLI lifetime",
    );
    await act(async () => setup.renderOnce());
    assert.doesNotMatch(setup.captureCharFrame(), /Thinking level for Luna/u);
    assert.ok(
      nodes(setup.renderer.root).some(
        (node) => node instanceof TextareaRenderable && node.focused,
      ),
    );
    assert.equal(opened.length, 1);
    // The footer names the new pair at once, not the last reply's model.
    assert.match(setup.captureCharFrame(), /openai\/luna/u);
    assert.doesNotMatch(setup.captureCharFrame(), /openai\/gpt-6-astra/u);
    assert.doesNotMatch(setup.captureCharFrame(), /Shiitake|OpenAI login/u);
    const thinking = await begin(setup, commandOwners[0], "thinking");
    assertOptions(setup, ["Model default", "low (current)", "medium"]);
    await press(setup, "escape");
    await act(async () => thinking.settled());
    assert.equal(opened.length, 1);
  });
});

test("cancel retains the mounted model; a rejected preference remains visible", async () => {
  let writeFailure;
  await withModels(
    async (context) => {
      const { setups, commandOwners, opened } = context;
      const setup = setups[0];
      const cancelled = await begin(setup, commandOwners[0], "model");
      await press(setup, "escape");
      await act(async () => cancelled.settled());
      assert.ok(
        nodes(setup.renderer.root).find(
          (node) => node instanceof TextareaRenderable && node.focused,
        ),
      );
      assert.match(setup.captureCharFrame(), /openai\/sol/u);

      const rejected = await begin(setup, commandOwners[0], "model");
      await press(setup, "down");
      await press(setup, "down");
      await press(setup, "enter");
      await press(setup, "down");
      await press(setup, "enter");
      await press(setup, "down");
      writeFailure = new Error("Preference rejected");
      await press(setup, "enter");
      await act(async () =>
        waitForFrame(setup, (frame) => frame.includes("Preference rejected")),
      );
      assert.match(setup.captureCharFrame(), /Preference rejected/u);
      assert.match(setup.captureCharFrame(), /openai\/sol/u);
      assert.doesNotMatch(setup.captureCharFrame(), /openai\/luna/u);
      assert.equal(opened.length, 1);
      assert.equal(context.closed, 0);
      await press(setup, "escape");
      await act(async () => rejected.settled());
      assert.ok(
        nodes(setup.renderer.root).find(
          (node) => node instanceof TextareaRenderable && node.focused,
        ),
      );
      assert.equal(opened.length, 1);
    },
    {
      beforeSave: async () => {
        if (writeFailure) throw writeFailure;
      },
    },
  );
});

test("unsigned model selection signs in before saving and keeps the same session", async () => {
  const actions = [];
  let configured = false;
  await withModels(
    async ({ setups, commandOwners, opened }) => {
      const setup = setups[0];
      const choosing = await begin(setup, commandOwners[0], "model");
      assert.match(setup.captureCharFrame(), /More providers \(1\)/u);
      await press(setup, "down");
      await press(setup, "down");
      await press(setup, "enter");
      assertOptions(setup, ["Use agent model", "Fungi", "OpenAI"]);
      await press(setup, "enter");
      assert.match(
        setup.captureCharFrame(),
        /How do you want to sign in to OpenAI/u,
      );
      await press(setup, "enter");
      assert.match(setup.captureCharFrame(), /Fixture API key/u);
      await act(async () => setup.mockInput.typeText("fixture-credential"));
      await press(setup, "enter");
      assertOptions(setup, ["OpenAI · Sol (current)", "OpenAI · Luna"]);
      await press(setup, "down");
      await press(setup, "enter");
      await press(setup, "enter");
      await act(async () => choosing.settled());
      assert.deepEqual(actions, ["login", "save"]);
      assert.equal(opened.length, 1);
      assert.equal(setups.length, 1);
      assert.equal(setup.renderer.isDestroyed, false);
    },
    {
      auth: async (request, interaction) => {
        if (request.command === "status")
          return configuredModelAccess(configured ? models : []);
        assert.deepEqual(request, {
          command: "login",
          provider: "openai",
          authType: "api_key",
        });
        const answer = await interaction.prompt({
          type: "text",
          message: "Fixture API key",
          secret: true,
        });
        assert.equal(answer, "fixture-credential");
        configured = true;
        actions.push("login");
        return { kind: "completed" };
      },
      beforeSave: async () => {
        assert.equal(configured, true);
        actions.push("save");
      },
    },
  );
});
