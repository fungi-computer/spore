import { expect, test } from "bun:test";
import { EmbeddedTerminalRenderable, RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { applyNativeTerminalDefaults } from "../src/button/index.js";

function cellAt(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  x: number,
  y = 0,
) {
  const line = setup.captureSpans().lines[y];
  expect(line).toBeDefined();
  let offset = 0;
  for (const span of line?.spans ?? []) {
    if (x < offset + span.width) return span;
    offset += span.width;
  }
  throw new Error(`Missing rendered cell ${String(x)},${String(y)}`);
}

function rgb(color: ReturnType<typeof cellAt>["fg"]) {
  return color.toInts().slice(0, 3);
}

test("embedded terminal defaults recolor without replacing program RGB", async () => {
  const setup = await createTestRenderer({
    width: 8,
    height: 2,
    useThread: false,
  });
  try {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      width: 8,
      height: 2,
    });
    setup.renderer.root.add(terminal);

    terminal.write(
      "D\u001b[48;2;0;0;0mB\u001b[0m\u001b[38;2;255;0;0mR\u001b[0m",
    );
    await setup.renderOnce();
    const initialForeground = rgb(cellAt(setup, 0).fg);
    const initialBackground = rgb(cellAt(setup, 0).bg);

    applyNativeTerminalDefaults(terminal, {
      foreground: RGBA.fromHex("#abcdef"),
      background: RGBA.fromHex("#123456"),
    });
    await setup.renderOnce();

    expect(rgb(cellAt(setup, 0).fg)).toEqual([171, 205, 239]);
    expect(rgb(cellAt(setup, 0).bg)).toEqual([18, 52, 86]);
    expect(rgb(cellAt(setup, 1).bg)).toEqual([0, 0, 0]);
    expect(rgb(cellAt(setup, 2).fg)).toEqual([255, 0, 0]);

    applyNativeTerminalDefaults(terminal, {
      foreground: undefined,
      background: undefined,
    });
    await setup.renderOnce();

    expect(rgb(cellAt(setup, 0).fg)).toEqual(initialForeground);
    expect(rgb(cellAt(setup, 0).bg)).toEqual(initialBackground);
    expect(rgb(cellAt(setup, 1).bg)).toEqual([0, 0, 0]);
    expect(rgb(cellAt(setup, 2).fg)).toEqual([255, 0, 0]);
  } finally {
    setup.renderer.destroy();
  }
});
