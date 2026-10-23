import { expect, spyOn, test } from "bun:test";
import { TextareaRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { act } from "react";
import { sigilGutterText } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { rendererInteraction } from "../src/renderer-interaction.js";

const idleStatus = `${sigilGutterText("●")}idle`;
import {
  createDesignTuiFixture,
  groupedToolsDesignSnapshot,
} from "./design-fixture.js";

const url =
  "https://example.test/reports/very-long-address/that-wraps-across-the-terminal?session=copy-proof";

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}

function urlFixture() {
  return createTuiFixture({
    messages: [
      {
        id: "copy-proof-assistant",
        commandId: null,
        sequence: 1,
        value: {
          role: "assistant",
          api: "pi",
          provider: "camel",
          model: "auto",
          content: [{ type: "text", text: url }],
          stopReason: "stop",
          timestamp: 1,
          usage: {
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
          },
        },
      },
    ],
  });
}

async function mount(
  width = 48,
  fixture = urlFixture(),
  readyText = "https://example.test",
  height = 22,
) {
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
      />
    </QueryClientProvider>,
    { width, height, ...rendererInteraction },
  );
  await act(async () => setup.renderOnce());
  await act(async () =>
    setup.waitForFrame((frame) => frame.includes(readyText)),
  );
  const close = async () => {
    await destroyTestRenderer(setup);
    commands.close();
    client.clear();
    await fixture.waitForClose();
  };
  return { setup, close, commands };
}

test("clicking transcript and status keeps the composer focused for typing", async () => {
  const { setup, close } = await mount();
  const copied = spyOn(setup.renderer, "copyToClipboardOSC52");
  try {
    const editor = descendants(setup.renderer.root).find(
      (node) => node instanceof TextareaRenderable,
    );
    if (!(editor instanceof TextareaRenderable))
      throw new Error("Missing composer");
    expect(editor.focused).toBe(true);
    const lines = setup.captureCharFrame().split("\n");
    const transcriptY = lines.findIndex((line) =>
      line.includes("https://example.test"),
    );
    const statusY = lines.findIndex((line) => line.includes(idleStatus));
    expect(transcriptY).toBeGreaterThanOrEqual(0);
    expect(statusY).toBeGreaterThanOrEqual(0);
    await act(async () => setup.mockMouse.click(8, transcriptY));
    expect(editor.focused).toBe(true);
    await act(async () => setup.mockMouse.click(8, statusY));
    expect(editor.focused).toBe(true);
    await act(async () => setup.mockInput.typeText("still typing"));
    expect(editor.plainText).toBe("still typing");
    expect(copied).not.toHaveBeenCalled();
  } finally {
    copied.mockRestore();
    await close();
  }
});

test("clicking a tool group toggles it without taking composer focus", async () => {
  const { setup, close } = await mount(
    100,
    createDesignTuiFixture({ snapshot: groupedToolsDesignSnapshot }),
    "6 calls",
    72,
  );
  try {
    const editor = descendants(setup.renderer.root).find(
      (node) => node instanceof TextareaRenderable,
    );
    if (!(editor instanceof TextareaRenderable))
      throw new Error("Missing composer");
    const before = setup.captureCharFrame();
    const lines = before.split("\n");
    const y = lines.findIndex((line) => line.includes("6 calls"));
    expect(y).toBeGreaterThanOrEqual(0);
    const groupLine = lines[y];
    if (groupLine === undefined) throw new Error("Missing tool group row");
    await act(async () =>
      setup.mockMouse.click(groupLine.indexOf("6 calls"), y),
    );
    await act(async () => setup.renderOnce());
    expect(editor.focused).toBe(true);
    expect(setup.captureCharFrame()).not.toBe(before);
  } finally {
    await close();
  }
});

test("a dialog takes focus and returns it to the composer", async () => {
  const { setup, close, commands } = await mount();
  try {
    const editor = descendants(setup.renderer.root).find(
      (node) => node instanceof TextareaRenderable,
    );
    if (!(editor instanceof TextareaRenderable))
      throw new Error("Missing composer");
    await setup.waitFor(() =>
      commands.snapshot().slash.some((command) => command.alias === "theme"),
    );
    const theme = commands
      .snapshot()
      .slash.find((command) => command.alias === "theme");
    if (theme === undefined) throw new Error("Missing theme command");
    await act(async () => {
      await commands.execute(theme.commandId, { origin: "slash" });
    });
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("Esc cancel")),
    );
    expect(editor.focused).toBe(false);
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).not.toContain("Esc cancel");
    expect(editor.focused).toBe(true);
  } finally {
    await close();
  }
});

test("selected text inside a dialog can be copied", async () => {
  const { setup, close, commands } = await mount();
  const copied = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(
    true,
  );
  try {
    await setup.waitFor(() =>
      commands.snapshot().slash.some((command) => command.alias === "theme"),
    );
    const theme = commands
      .snapshot()
      .slash.find((command) => command.alias === "theme");
    if (theme === undefined) throw new Error("Missing theme command");
    await act(async () => {
      await commands.execute(theme.commandId, { origin: "slash" });
    });
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("Esc cancel")),
    );
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Theme"));
    const line = lines[y];
    if (line === undefined) throw new Error("Missing dialog title");
    const x = line.indexOf("Theme");
    await act(async () => setup.mockMouse.drag(x, y, x + 5, y));
    expect(copied).toHaveBeenCalled();
    await act(async () =>
      setup.waitForFrame((frame) =>
        frame.includes("Copy request sent to terminal"),
      ),
    );
  } finally {
    copied.mockRestore();
    await close();
  }
});

test("selecting a wrapped URL copies the complete source URL", async () => {
  const { setup, close } = await mount();
  const copied = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(
    true,
  );
  try {
    const lines = setup.captureCharFrame().split("\n");
    const startY = lines.findIndex((line) =>
      line.includes("https://example.test"),
    );
    expect(startY).toBeGreaterThanOrEqual(0);
    const endY = lines.findIndex((line) => line.includes("session=copy-proof"));
    expect(endY).toBeGreaterThan(startY);
    const startLine = lines[startY];
    if (startLine === undefined) throw new Error("Missing URL row");
    await act(async () =>
      setup.mockMouse.drag(startLine.indexOf("https://"), startY, 35, endY),
    );
    expect(copied.mock.calls[0]?.[0]).toBe(url);
    await act(async () =>
      setup.waitForFrame((frame) =>
        frame.includes("Copy request sent to terminal"),
      ),
    );
    expect(setup.captureCharFrame()).toContain("Copy request sent to terminal");
  } finally {
    copied.mockRestore();
    await close();
  }
});
