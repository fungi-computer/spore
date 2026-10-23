import { idleActivity } from "@fungi.computer/parakeet-testing";
import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWhistle,
  createWhistleKeymapAdapter,
  type WhistleKeymapHost,
} from "@fungi.computer/whistle";
import type { SessionSnapshot } from "@fungi.computer/shiitake/client";
import { act } from "react";
import { TuiFrame } from "../src/frame.js";
import { createDesignTuiFixture } from "./design-fixture.js";
import { captureCells, captureSigilPlacements } from "./frame-cells.js";

/**
 * Levi: "The sub-agent messages should start collapsed and be expandable ...
 * give them a sigil too instead of that little arrow in the gutter."
 * A message another Agent sent in is one collapsed line (sigil, name, preview)
 * that the tool rows' own key (Ctrl+G) and click expand into the compact block;
 * every human line keeps the raised user surface, unchanged.
 */

type Message = SessionSnapshot["messages"][number];

function user(
  id: string,
  sequence: number,
  content: string,
  meta?: Message["meta"],
): Message {
  const message: Message = {
    id,
    commandId: id,
    sequence,
    value: { role: "user", content, timestamp: sequence },
  };
  return meta === undefined ? message : { ...message, meta };
}

const agentMeta = {
  author: { id: "agent_research", name: "Research agent", kind: "agent" },
};
const visitorMeta = { author: { id: "visitor_ada", name: "Ada" } };

const glyph = {
  text: "\u{10eeee}\u0305\u0305\u{10eeee}\u0305\u030d\u{10eeee}\u0305\u030e",
  color: RGBA.fromInts(0, 240, 9),
};
const toolSigils = {
  agent: glyph,
  code: glyph,
  command: glyph,
  edit: glyph,
  error: glyph,
  other: glyph,
  read: glyph,
  search: glyph,
};

type Setup = Awaited<ReturnType<typeof testRender>>;

async function render(
  messages: Message[],
  waitFor: string,
  options: {
    sigils?: boolean;
    steps?: (setup: Setup, lines: () => string[]) => Promise<void>;
  } = {},
) {
  const fixture = createDesignTuiFixture({
    snapshot: {
      pending: { total: 0, prompts: [], hasMore: false },
      sessionId: "tui-agent-message",
      cursor: "agent-message-cursor",
      hasMore: false,
      oldestCursor: null,
      messages,
      terminals: [],
      compactions: [],
      activity: idleActivity,
      toolOutput: [],
      progress: null,
      extensions: {},
      attention: [],
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        initialTheme="mocha"
        {...(options.sigils === true ? { toolSigils } : {})}
      />
    </QueryClientProvider>,
    { width: 60, height: 30 },
  );
  // The same native keymap adapter the terminal application installs.
  const nativeKeymap = createDefaultOpenTuiKeymap(setup.renderer);
  const keymap = createWhistleKeymapAdapter(
    {
      registerLayer: (layer) =>
        nativeKeymap.registerLayer({
          ...layer,
          target: setup.renderer.root,
          priority: 100,
        }),
    } satisfies WhistleKeymapHost,
    commands,
    "keyboard",
  );
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes(waitFor)),
    );
    const settle = async () => {
      await act(async () => setup.renderOnce());
      await act(async () => setup.renderOnce());
    };
    await settle();
    const currentLines = () => setup.captureCharFrame().split("\n");
    await options.steps?.(setup, currentLines);
    await settle();
    const frame = captureCells(setup);
    const lines = currentLines();
    const bg = (x: number, y: number) =>
      frame.cells.find((cell) => cell.x === x && cell.y === y)?.bg.join(",") ??
      "missing";
    const rowOf = (text: string) =>
      lines.findIndex((line) => line.includes(text));
    const gutter = (y: number) =>
      frame.cells
        .filter((cell) => cell.y === y && cell.x < 3)
        .map((cell) => cell.text)
        .join("");
    return {
      lines,
      bg,
      rowOf,
      gutter,
      placements: captureSigilPlacements(frame),
    };
  } finally {
    keymap.cleanup();
    await destroyTestRenderer(setup);
    client.clear();
    commands.close();
  }
}

const reply = [
  user("human", 1, "human question", visitorMeta),
  user(
    "agent",
    2,
    "Findings: three kilns ready\nSecond line of detail",
    agentMeta,
  ),
];

test("another Agent's message starts collapsed as one line: name and preview, no raised user surface", async () => {
  const view = await render(reply, "Research agent");
  const ground = view.bg(0, 0);
  const human = view.rowOf("human question");
  const header = view.rowOf("Research agent");
  expect(header).toBeGreaterThan(human);
  expect(view.lines[header]).toContain(
    "Research agent · Findings: three kilns ready",
  );
  expect(view.lines[header]).not.toContain("Second line of detail");
  expect(view.lines.join("\n")).not.toContain("Second line of detail");
  expect(view.bg(0, human)).not.toBe(ground);
  for (const y of [header - 1, header, header + 1])
    expect(view.bg(0, y)).toBe(ground);
});

test("the tool-row key (Ctrl+G) expands another Agent's message to the full block and toggles it back", async () => {
  const expanded = await render(reply, "Research agent", {
    steps: async (setup) => {
      await act(async () => {
        setup.mockInput.pressKey("g", { ctrl: true });
        await setup.renderOnce();
      });
    },
  });
  const header = expanded.rowOf("Research agent");
  expect(expanded.lines[header]?.trim()).toBe("Research agent");
  expect(expanded.lines[header + 1]).toContain("Findings: three kilns ready");
  expect(expanded.lines[header + 2]).toContain("Second line of detail");
  const collapsed = await render(reply, "Research agent", {
    steps: async (setup) => {
      await act(async () => {
        setup.mockInput.pressKey("g", { ctrl: true });
        await setup.renderOnce();
      });
      await act(async () => {
        setup.mockInput.pressKey("g", { ctrl: true });
        await setup.renderOnce();
      });
    },
  });
  expect(collapsed.lines.join("\n")).not.toContain("Second line of detail");
});

test("a click on the row expands another Agent's message and a second click collapses it", async () => {
  const click = async (setup: Setup, lines: () => string[]) => {
    const y = lines().findIndex((line) => line.includes("Research agent"));
    await act(async () => setup.mockMouse.click(8, y));
  };
  const expanded = await render(reply, "Research agent", {
    steps: async (setup, lines) => {
      await click(setup, lines);
    },
  });
  expect(expanded.lines.join("\n")).toContain("Second line of detail");
  const collapsed = await render(reply, "Research agent", {
    steps: async (setup, lines) => {
      await click(setup, lines);
      await click(setup, lines);
    },
  });
  expect(collapsed.lines.join("\n")).not.toContain("Second line of detail");
});

test("the gutter shows the Agent sigil instead of the arrow, collapsed and expanded", async () => {
  for (const steps of [
    undefined,
    async (setup: Setup) => {
      await act(async () => {
        setup.mockInput.pressKey("g", { ctrl: true });
        await setup.renderOnce();
      });
    },
  ]) {
    const options: Parameters<typeof render>[2] = { sigils: true };
    if (steps !== undefined) options.steps = steps;
    const view = await render(reply, "Research agent", options);
    const header = view.rowOf("Research agent");
    expect(view.gutter(header)).toBe(glyph.text);
    expect(view.placements.filter((cell) => cell.y === header)).toHaveLength(1);
    expect(view.lines.join("\n")).not.toContain("↳");
  }
});

test("human lines keep the raised user surface and gain no name caption", async () => {
  const view = await render(
    [
      user("visitor", 1, "visitor line", visitorMeta),
      user("plain", 2, "plain line"),
      user("lookalike", 3, "↳ Research agent replied: done", visitorMeta),
    ],
    "↳ Research agent replied: done",
  );
  const ground = view.bg(0, 0);
  for (const text of [
    "visitor line",
    "plain line",
    "↳ Research agent replied: done",
  ])
    expect(view.bg(0, view.rowOf(text))).not.toBe(ground);
  expect(view.lines.join("\n")).not.toContain("Ada");
  expect(view.lines.filter((line) => line.includes("↳")).length).toBe(1);
});

test("an Agent message between human lines splits their stacked surface", async () => {
  const view = await render(
    [
      user("first", 1, "first human line"),
      user("agent", 2, "agent message body", agentMeta),
      user("second", 3, "second human line"),
    ],
    "second human line",
  );
  const ground = view.bg(0, 0);
  const first = view.rowOf("first human line");
  expect(view.bg(0, first + 2)).toBe(ground);
  expect(view.rowOf("Research agent")).toBe(first + 3);
  expect(view.bg(0, view.rowOf("Research agent") + 1)).toBe(ground);
});
