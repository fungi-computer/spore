import { readFile } from "node:fs/promises";
import { RGBA } from "@opentui/core";
import type { ToolSigils, ToolSigilGlyph } from "./button/index.js";
import { gutterSigils } from "./button/tool-sigils.js";
import { z } from "zod";

/**
 * Wrap one complete escape sequence for tmux's own DCS passthrough framing
 * (`\ePtmux;` + every ESC byte in the sequence doubled + a closing `\e\\`).
 * OpenTUI's native layer wraps its own startup queries the same way
 * (`packages/native/src/ansi.zig`'s `wrapForTmux`) because tmux otherwise
 * swallows unknown escape sequences instead of forwarding them to the real
 * outer terminal. That native wrap is internal to OpenTUI's own image
 * pipeline and is not exposed on the public `writeOut` path our gutter
 * glyphs use, so this module — the one that owns their transport — mirrors
 * the same byte format. Call this once per whole sequence, never on a
 * fragment, so a sequence is never wrapped twice.
 */
export function wrapForTmuxPassthrough(sequence: string): string {
  return `\u001bPtmux;${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`;
}

const imageSchema = z.strictObject({
  cellWidth: z.number().int().min(1).max(256),
  cellHeight: z.number().int().min(1).max(256),
  images: z.record(z.enum(gutterSigils), z.tuple([z.base64(), z.base64()])),
});
/** Transmit build-generated artwork once for this renderer's lifetime. */
export async function loadToolSigils(
  write: (data: string) => void,
): Promise<ToolSigils> {
  const assets = imageSchema.parse(
    JSON.parse(
      await readFile(
        new URL("./tool-sigil-images.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const install = (kind: keyof typeof gutterSigils): ToolSigilGlyph => {
    const name = gutterSigils[kind];
    const id = 0x00f001 + Object.values(gutterSigils).indexOf(name);
    const png = assets.images[name][1];
    for (let offset = 0; offset < png.length; offset += 4_096) {
      const remaining = offset + 4_096 < png.length ? 1 : 0;
      const header = offset === 0 ? `a=t,f=100,i=${String(id)},q=2,` : "q=2,";
      write(
        `\u001b_G${header}m=${String(remaining)};${png.slice(offset, offset + 4_096)}\u001b\\`,
      );
    }
    // Three columns, not two: the pane's own left inset is free space
    // (nothing else draws there), and the extra column lets the artwork's
    // opaque center land exactly on the gutter dot's center -- the gutter
    // dot sits in the SECOND of these three columns, not the first. Column
    // diacritics 0 and 1 (U+0305, U+030D) are already proven correct by the
    // two existing characters below; column 2's U+030E comes from kitty's
    // own rowcolumn-diacritics table (diacritic_to_num: 0x30e \u2192 num 3 \u2192
    // 0-based column 2), not a guess.
    write(`\u001b_Ga=p,i=${String(id)},U=1,c=3,r=1,q=2;\u001b\\`);
    return {
      text: "\u{10eeee}\u0305\u0305\u{10eeee}\u0305\u030d\u{10eeee}\u0305\u030e",
      color: RGBA.fromInts((id >>> 16) & 255, (id >>> 8) & 255, id & 255),
    };
  };
  return {
    code: install("code"),
    command: install("command"),
    edit: install("edit"),
    other: install("other"),
    read: install("read"),
    search: install("search"),
    // The run-error gutter mark; installed last so tool ids stay stable.
    error: install("error"),
    // Another Agent's message; appended so earlier ids stay stable.
    agent: install("agent"),
  };
}

/** Release only the gutter images owned by this TUI; leave other terminal images. */
export function deleteToolSigils(write: (data: string) => void): void {
  for (let index = 0; index < Object.values(gutterSigils).length; index++) {
    write(`\u001b_Ga=d,d=I,i=${String(0x00f001 + index)},q=2;\u001b\\`);
  }
}
