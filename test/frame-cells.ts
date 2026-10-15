import { RGBA } from "@opentui/core";
import { stringWidth } from "bun";
import type { Setup } from "./frame-capture.js";

/** Read native framebuffer colours at the actual grapheme cell coordinates. */
export function captureCells(
  setup: Pick<Setup, "renderer" | "captureCharFrame">,
) {
  const buffer = setup.renderer.currentRenderBuffer.buffers;
  const lines = setup.captureCharFrame().split("\n");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const cells = [];
  for (const [y, line] of lines.entries()) {
    let x = 0;
    for (const { segment: text } of segmenter.segment(line)) {
      const width = stringWidth(text);
      const index = (y * setup.renderer.width + x) * 4;
      if (width > 0)
        cells.push({
          x,
          y,
          text,
          width,
          fg: RGBA.fromArray(buffer.fg.slice(index, index + 4)).toInts(),
          bg: RGBA.fromArray(buffer.bg.slice(index, index + 4)).toInts(),
          attributes: buffer.attributes[y * setup.renderer.width + x] ?? 0,
        });
      x += width;
    }
  }
  return { cols: setup.renderer.width, rows: setup.renderer.height, cells };
}

/** One origin for the owned two-cell image: column 1 is a continuation.
 * https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
 */
export function captureSigilPlacements(frame: ReturnType<typeof captureCells>) {
  return frame.cells.filter((cell) => cell.text === "\u{10eeee}\u0305\u0305");
}
