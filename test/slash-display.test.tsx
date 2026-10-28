import { expect, test } from "bun:test";
import { createWhistle } from "@fungi.computer/whistle";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  createParakeetInteractions,
  completeSlash,
  slashRegistry,
  type SlashCommandController,
  type SlashCompletion,
} from "@fungi.computer/parakeet/headless";
import {
  SlashCompletionList,
  slashRows,
} from "../src/button/slash-completion.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

const payload = "safe\u001b]52;c;Y21k\u0007\u009d\u202e end";
const completion: SlashCompletion = {
  kind: "arguments",
  query: "",
  hint: payload,
  command: {
    alias: "fixture",
    commandId: "fixture",
    command: { namespace: "test", id: "fixture" },
    title: "Fixture",
    category: "test",
    order: 0,
    keys: [],
    availability: { status: "available" },
  },
  items: [
    {
      word: { word: "value", description: payload, arguments: {} },
      label: "value",
      matches: [],
      insert: "/fixture value",
    },
  ],
};
test("slash argument descriptions reject hostile terminal text", () => {
  expect(slashRows(completion)[0]?.detail).toBe("safe end");
});
test("slash native hint fitting rejects hostile terminal text", async () => {
  const store = createParakeetInteractions();
  const slash: SlashCommandController = {
    completion,
    open: true,
    selected: 0,
    hints: [],
    store,
    awaiting: { items: [], position: 0, total: 0, forced: false },
    interactions: store.snapshot(),
    move: () => false,
    highlight: () => undefined,
    complete: () => false,
    dismiss: () => false,
    submit: () => undefined,
    choose: () => undefined,
    available: () => false,
    runCommand: () => undefined,
  };
  function View() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <SlashCompletionList
        slash={slash}
        colors={colors}
        maxRows={3}
        width={100}
      />
    );
  }
  const setup = await testRender(<View />, { width: 100, height: 10 });
  try {
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("safe end");
    expect(setup.captureCharFrame()).not.toMatch(
      /[^\P{Cc}\n\t]|[\u202a-\u202e\u2066-\u2069]/u,
    );
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const width of [80, 160]) {
  test(`idle slash shows only available conversation rows at ${String(width)} columns`, async () => {
    const commands = createWhistle();
    commands.contribute({
      sourceId: "display",
      namespace: "display",
      commands: [
        {
          id: "goal",
          title: "Goal",
          category: "Conversation",
          projections: { slash: { aliases: ["goal"] } },
          handler: () => undefined,
        },
        {
          id: "retry",
          title: "Retry",
          category: "Conversation",
          availability: () => ({
            status: "unavailable",
            reason: "No failed run.",
          }),
          projections: { slash: { aliases: ["retry"] } },
          handler: () => undefined,
        },
        {
          id: "session",
          title: "Session status",
          category: "Advanced",
          projections: { slash: { aliases: ["session"] } },
          handler: () => undefined,
        },
        {
          id: "model",
          title: "Model",
          category: "Settings",
          projections: { slash: { aliases: ["model"] } },
          handler: () => undefined,
        },
      ],
    });
    const completion = completeSlash(slashRegistry(commands.snapshot()), "/");
    const store = createParakeetInteractions();
    const slash: SlashCommandController = {
      completion,
      open: true,
      selected: 0,
      hints: [],
      store,
      awaiting: { items: [], position: 0, total: 0, forced: false },
      interactions: store.snapshot(),
      move: () => false,
      highlight: () => undefined,
      complete: () => false,
      dismiss: () => false,
      submit: () => undefined,
      choose: () => undefined,
      available: () => false,
      runCommand: () => undefined,
    };
    function View() {
      const { colors } = useTerminalTheme("mocha");
      return (
        <SlashCompletionList
          slash={slash}
          colors={colors}
          maxRows={6}
          width={width}
        />
      );
    }
    const setup = await testRender(<View />, {
      width,
      height: width === 80 ? 24 : 48,
    });
    try {
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("/goal");
      // Common commands lead the idle list; unavailable ones never show.
      expect(setup.captureCharFrame()).toContain("/model");
      expect(setup.captureCharFrame()).not.toMatch(/\/(retry|session)/u);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}

test("slash commands use plain descriptions and reveal grammar only after the command", () => {
  const commands = createWhistle();
  commands.contribute({
    sourceId: "goal-description",
    namespace: "goal",
    commands: [
      {
        id: "goal",
        title: "Goal",
        description: "Set what to work toward",
        category: "Conversation",
        projections: {
          slash: {
            aliases: ["goal"],
            arguments: {
              hint: "<objective>",
              text: { field: "objective", arguments: {} },
            },
          },
        },
        handler: () => undefined,
      },
    ],
  });
  const registry = slashRegistry(commands.snapshot());
  expect(slashRows(completeSlash(registry, "/"))[0]?.detail).toBe(
    "Set what to work toward",
  );
  const argumentsCompletion = completeSlash(registry, "/goal ");
  expect(argumentsCompletion).toMatchObject({
    kind: "arguments",
    hint: "/goal <objective>",
  });
});
