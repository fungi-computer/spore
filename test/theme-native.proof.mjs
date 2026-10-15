import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { pressDecodedKey } from "./native-readiness.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  CodeRenderable,
  TextRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { setRendererCapabilities } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";
import { createWhistle } from "@fungi.computer/whistle";

import { TuiFrame } from "@fungi.computer/tui/frame";
import { createDesignTuiFixture } from "./design-fixture.ts";

class TtyInput extends Readable {
  isTTY = true;

  _read() {
    // The proof supplies terminal replies through respond().
  }

  setRawMode() {
    return this;
  }

  respond(sequence) {
    this.emit("data", Buffer.from(sequence));
  }
}

function nodes(node) {
  return [node, ...node.getChildren().flatMap(nodes)];
}

async function finishHighlighting(setup) {
  await Promise.all(
    nodes(setup.renderer.root)
      .filter((node) => node instanceof CodeRenderable)
      .map((node) => node.highlightingDone),
  );
}

class TtyOutput extends Writable {
  isTTY = true;
  pending = [];
  colors;

  constructor(input, width) {
    super();
    this.input = input;
    this.columns = width;
    this.rows = 28;
  }

  getColorDepth() {
    return 24;
  }

  _write(chunk, encoding, callback) {
    this.pending.push(chunk.toString());
    this.reply();
    callback();
  }

  respondWith(colors) {
    this.colors = colors;
    this.reply();
  }

  reply() {
    if (!this.colors) return;
    const { foreground, background, palette } = this.colors;
    for (const query of this.pending.splice(0)) {
      let response = "";
      for (const [index, color] of palette.entries()) {
        if (query.includes(`\x1b]4;${index};?`))
          response += `\x1b]4;${index};#${color}\x07`;
      }
      for (const index of [10, 11, 12, 13, 14, 15, 16, 17, 19]) {
        if (query.includes(`\x1b]${index};?`))
          response += `\x1b]${index};#${index === 11 ? background : foreground}\x07`;
      }
      if (response) this.input.respond(response);
    }
  }
}

function frameSpans(setup, text) {
  const line = setup.captureSpans().lines.find((row) =>
    row.spans
      .map((span) => span.text)
      .join("")
      .includes(text),
  );
  assert.ok(line, `expected rendered text: ${text}`);
  return line.spans;
}

function frameCell(setup, x, y) {
  const line = setup.captureSpans().lines[y];
  assert.ok(line, `expected native row ${y}`);
  let offset = 0;
  for (const span of line.spans) {
    if (x < offset + span.width) return span;
    offset += span.width;
  }
  assert.fail(`expected native cell ${x},${y}`);
}

function framePosition(setup, text) {
  const row = setup
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes(text));
  assert.ok(row >= 0, `expected native text: ${text}`);
  const column = setup.captureCharFrame().split("\n")[row].indexOf(text);
  assert.ok(column >= 0);
  return { x: column, y: row };
}

function assertFrameColors(setup, mode) {
  const foreground = mode === "light" ? "202020" : "d0d0d0";
  const background = mode === "light" ? "f8f8f8" : "101010";
  const success = mode === "light" ? "66cc66" : "88ee88";
  const status = frameSpans(setup, "● streaming");
  const dot = status.find((span) => span.text.includes("●"));
  const statusNode = nodes(setup.renderer.root).find(
    (node) => node.text === "● streaming",
  );
  assert.ok(
    JSON.stringify(dot?.fg.toInts()) ===
      JSON.stringify(RGBA.fromHex(`#${success}`).toInts()),
    `status uses terminal intent: ${JSON.stringify({
      actual: dot?.fg.toInts(),
      renderable: statusNode?.fg?.toInts(),
      capabilities: setup.renderer.capabilities,
    })}`,
  );
  const markdown = frameSpans(setup, "TuiFrame");
  assert.ok(
    markdown.some(
      (span) =>
        JSON.stringify(span.fg.toInts()) ===
        JSON.stringify(RGBA.fromHex(`#${foreground}`).toInts()),
    ),
    "Markdown keeps the terminal foreground readable",
  );
  assert.ok(
    markdown.every(
      (span) =>
        JSON.stringify(span.bg.toInts()) ===
        JSON.stringify(RGBA.fromHex(`#${background}`).toInts()),
    ),
    `Markdown keeps the terminal background readable: ${JSON.stringify(
      markdown.map((span) => ({ text: span.text, bg: span.bg.toInts() })),
    )}`,
  );
}

async function assertNativeSelection(setup) {
  const code = nodes(setup.renderer.root).find(
    (node) =>
      node instanceof CodeRenderable && node.content.includes("TuiFrame"),
  );
  assert.ok(code, "fixture exposes maintained Markdown code rendering");
  const position = framePosition(setup, "<TuiFrame");
  const before = frameCell(setup, position.x, position.y);
  // Releasing the button copies the selection and clears it, so inspect the
  // native selection while the drag is still held.
  await act(async () => {
    await setup.mockMouse.pressDown(position.x, position.y);
    await setup.mockMouse.moveTo(position.x + 4, position.y);
    await setup.renderOnce();
  });
  assert.ok(
    setup.renderer.hasSelection,
    `native renderer owns code selection: ${JSON.stringify({
      position,
      code: {
        x: code.x,
        y: code.y,
        screenX: code.screenX,
        screenY: code.screenY,
        width: code.width,
        height: code.height,
      },
    })}`,
  );
  assert.match(code.getSelectedText(), /Tui/u);
  const selected = frameCell(setup, position.x, position.y);
  assert.notDeepEqual(
    [selected.fg.toInts(), selected.bg.toInts(), selected.attributes],
    [before.fg.toInts(), before.bg.toInts(), before.attributes],
    `selected Markdown code changes native state: ${JSON.stringify({
      before: {
        fg: before.fg.toInts(),
        bg: before.bg.toInts(),
        attributes: before.attributes,
      },
      selected: {
        fg: selected.fg.toInts(),
        bg: selected.bg.toInts(),
        attributes: selected.attributes,
      },
    })}`,
  );
  // Clear first so the release has nothing to copy and raises no toast.
  setup.renderer.clearSelection();
  await act(async () => {
    await setup.mockMouse.release(position.x + 4, position.y);
  });
}

function fixtureCodeAndScroll(setup) {
  const code = nodes(setup.renderer.root).find(
    (node) =>
      node instanceof CodeRenderable && node.content.includes("TuiFrame"),
  );
  const scroll = nodes(setup.renderer.root).find(
    (node) => node instanceof ScrollBoxRenderable,
  );
  assert.ok(
    code && scroll,
    "fixture has maintained Markdown code in the timeline",
  );
  return { code, scroll };
}

async function showFixtureCode(setup) {
  const { code, scroll } = fixtureCodeAndScroll(setup);
  await act(async () => {
    scroll.scrollBy(code.y - scroll.viewport.y - 2);
    await setup.renderOnce();
  });
  assert.match(setup.captureCharFrame(), /TuiFrame/u);
}

async function assertFixtureMarkdown(setup) {
  const markdown = nodes(setup.renderer.root).find(
    (node) =>
      node instanceof TextRenderable && node.plainText.includes("Hierarchy"),
  );
  assert.ok(markdown, "fixture Markdown retains its styled text");
  assert.match(markdown.plainText, /Hierarchy: prompts and replies/u);
  const { code, scroll } = fixtureCodeAndScroll(setup);
  await act(async () => {
    scroll.scrollTo(Math.max(0, code.y - 12));
    await setup.renderOnce();
  });
  assert.match(
    setup.captureCharFrame(),
    /Hierarchy: prompts and replies/u,
    "native Markdown list bodies remain readable",
  );
  assert.match(
    setup.captureCharFrame(),
    /should be distinct/u,
    "wrapped Markdown list text remains readable beside the scrollbar",
  );
}

async function captureFrame(setup, name) {
  const directory = process.env.THEME_CAPTURE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.txt`), setup.captureCharFrame());
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify(
      setup.captureSpans().lines.map((line) => ({
        spans: line.spans.map((span) => ({
          text: span.text,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
        })),
      })),
      null,
      2,
    ),
  );
}

async function openThemePicker(setup, commands) {
  const command = commands
    .snapshot()
    .slash.find((candidate) => candidate.alias === "theme");
  assert.ok(command);
  assert.equal(command.title, "Theme");
  await act(async () => {
    const outcome = await commands.execute(command.commandId, {
      origin: "slash",
    });
    assert.equal(outcome.status, "handled");
  });
  await act(async () => {
    await setup.renderOnce();
  });
  assert.match(
    setup.captureCharFrame(),
    /↑↓ preview · Enter save · Esc cancel/u,
  );
}

async function previewNextTheme(setup, commands) {
  await openThemePicker(setup, commands);
  await act(async () => {
    setup.mockInput.pressArrow("down");
  });
  await act(async () => {
    await setup.renderOnce();
  });
}

async function runFrame({ width, mode, interactive = false }) {
  const input = new TtyInput();
  const output = new TtyOutput(input, width);
  const fixture = createDesignTuiFixture();
  const commands = createWhistle();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const confirmed = [];
  let exits = 0;
  const setup = await testRender(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TuiFrame, {
        commands,
        session: fixture.session,
        initialTheme: "terminal",
        onExit: () => {
          exits += 1;
        },
        onThemeConfirm: async (theme) => {
          confirmed.push(theme);
        },
      }),
    ),
    { width, height: 28, stdin: input, stdout: output },
  );
  try {
    await setup.renderer.setupTerminal();
    setRendererCapabilities(setup.renderer, {
      ansi256: true,
      rgb: false,
      remote: false,
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.mockInput.typeText("typing before palette response");
      await setup.renderOnce();
    });
    assert.match(
      setup.captureCharFrame(),
      /before palette response/u,
      "initial input does not wait for palette detection",
    );
    await act(async () => {
      setup.mockInput.pressKey("u", { ctrl: true });
      await setup.renderOnce();
    });

    assert.equal(setup.renderer.listenerCount("palette"), 1);
    assert.equal(setup.renderer.listenerCount("theme_mode"), 1);
    const palette = [
      "101010",
      "cc6666",
      "66cc66",
      "cccc66",
      "6699cc",
      "cc99cc",
      "66cccc",
      "d0d0d0",
      "303030",
      "ff6666",
      "88ee88",
      "eeee88",
      "88aaee",
      "eeaaee",
      "88eeee",
      "ffffff",
    ];
    const foreground = mode === "light" ? "202020" : "d0d0d0";
    const background = mode === "light" ? "f8f8f8" : "101010";
    await act(async () => {
      input.respond(`\x1b]10;#${foreground}\x07\x1b]11;#${background}\x07`);
      const detected = setup.renderer.getPalette({ size: 16 });
      output.respondWith({ foreground, background, palette });
      await detected;
      await setup.waitForVisualIdle();
      await setup.renderOnce();
    });
    assert.equal(setup.renderer.themeMode, mode);
    const detected = await setup.renderer.getPalette({ size: 16 });
    assert.equal(detected.defaultForeground, `#${foreground}`);
    assert.equal(detected.defaultBackground, `#${background}`);
    assert.equal(detected.palette[2], `#${palette[2]}`);
    assert.equal(detected.palette[10], `#${palette[10]}`);
    await act(async () => {
      await setup.renderOnce();
      await finishHighlighting(setup);
      await setup.renderOnce();
    });
    await assertFixtureMarkdown(setup);
    await showFixtureCode(setup);
    assertFrameColors(setup, mode);
    await captureFrame(setup, `${mode}-${width}`);
    if (!interactive) return;
    await assertNativeSelection(setup);
    await setup.waitFor(() =>
      commands.snapshot().slash.some((command) => command.alias === "theme"),
    );
    await previewNextTheme(setup, commands);
    assert.ok(
      frameSpans(setup, "Theme").some(
        (span) =>
          JSON.stringify(span.bg.toInts()) ===
          JSON.stringify(RGBA.fromHex("#1e1e2e").toInts()),
      ),
      "Mocha preview changes the live frame before confirmation",
    );
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await act(async () => {
      await setup.renderOnce();
    });
    assert.deepEqual(confirmed, ["mocha"]);
    assert.doesNotMatch(setup.captureCharFrame(), /↑↓ preview · Enter save/u);
    const composer = nodes(setup.renderer.root).find(
      (node) => node instanceof TextareaRenderable,
    );
    assert.ok(composer);
    assert.equal(
      setup.renderer.currentFocusedRenderable,
      composer,
      "theme dismissal returns focus to the composer",
    );
    await act(async () => {
      await setup.mockMouse.click(composer.x + 1, composer.y);
      await setup.renderOnce();
    });
    assert.equal(
      composer.focused,
      true,
      "composer accepts native focus after dismissal",
    );
    await act(async () => {
      await setup.mockInput.typeText("focus returns");
      await setup.renderOnce();
    });
    assert.match(setup.captureCharFrame(), /focus returns/u);

    await act(async () => {
      setup.mockInput.pressKey("u", { ctrl: true });
      await setup.renderOnce();
    });
    await previewNextTheme(setup, commands);
    await pressDecodedKey(setup, () => setup.mockInput.pressEscape());
    await act(async () => {
      await setup.renderOnce();
    });
    assert.equal(exits, 0, "Escape cancels the picker before frame exit");
    assert.deepEqual(confirmed, ["mocha"], "Escape does not persist preview");
    assert.doesNotMatch(setup.captureCharFrame(), /↑↓ preview · Enter save/u);
    assert.ok(
      frameSpans(setup, "● streaming").some(
        (span) =>
          JSON.stringify(span.fg.toInts()) ===
          JSON.stringify(RGBA.fromHex("#a6e3a1").toInts()),
      ),
      `Escape restores the confirmed Mocha frame: ${JSON.stringify(
        frameSpans(setup, "● streaming").map((span) => span.fg.toInts()),
      )}`,
    );
    await act(async () => {
      await setup.mockInput.typeText(" after escape");
      await setup.renderOnce();
    });
    assert.match(setup.captureCharFrame(), /after escape/u);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
    assert.equal(setup.renderer.listenerCount("palette"), 0);
    assert.equal(setup.renderer.listenerCount("theme_mode"), 0);
    client.clear();
    commands.close();
    await fixture.waitForClose();
    assert.equal(fixture.closeCalls(), 1);
  }
}

export async function runThemeProof() {
  await runFrame({ width: 96, mode: "dark", interactive: true });
  await runFrame({ width: 36, mode: "dark" });
  await runFrame({ width: 96, mode: "light" });
  await runFrame({ width: 36, mode: "light" });
  process.stdout.write(
    `${JSON.stringify({ proof: "tui-theme-native", verdict: "pass" })}\n`,
  );
}

if (import.meta.main) await runThemeProof();
