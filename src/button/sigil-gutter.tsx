import { stringWidth } from "bun";
import type { ToolSigilGlyph } from "./tool-sigils.js";

/**
 * The one left gutter every timeline row and footer row reserves before its
 * text: the same two cells a tool-kind image already filled -- no wider.
 * Whichever mark names the row's state (tool-kind artwork, the run-error
 * sigil, or a plain status dot) centers in those two cells instead of
 * sizing its own; a two-cell image still fills it exactly, and a one-cell
 * dot centers as closely as an even width allows (left cell). No row sizes
 * its own gutter, and the text column after it never moves: every row that
 * draws a left mark uses this width, so timeline sigils and footer sigils
 * sit in the same screen column.
 */
export const sigilGutterWidth = 2;
/** What a caller's text budget must subtract once this gutter renders. */
export const sigilGutterTotalWidth = sigilGutterWidth;

function gutterPadding(markWidth: number) {
  const left = Math.max(0, Math.floor((sigilGutterWidth - markWidth) / 2));
  return { left, right: Math.max(0, sigilGutterWidth - markWidth - left) };
}

/**
 * Centers a plain, single-color mark -- a status dot, or nothing -- in the
 * gutter, as text a caller bakes into a line it colors itself (the footer's
 * one tone per row). An empty mark still reserves the whole width, so every
 * row's text starts in the same column whether or not it carries a mark.
 */
export function sigilGutterText(mark = ""): string {
  const { left, right } = gutterPadding(stringWidth(mark));
  return `${" ".repeat(left)}${mark}${" ".repeat(right)}`;
}

/**
 * The three columns a tool-kind icon's image spans: the pane's own left
 * inset -- reclaimed from that row's own left padding, which must shrink
 * by exactly this much so the row's text never moves -- plus the existing
 * two-cell gutter. The uploaded artwork is pre-composited (at build time,
 * see build-tool-sigils.mjs) so its own opaque center already lands on
 * the gutter dot's center, the same single cell the dot has always
 * occupied; this component only prints the already-correct glyph, or an
 * equally-wide blank for a terminal without image support, exactly as
 * the glyph itself was already optional before this.
 */
export const iconGutterWidth = 3;

export function ToolIcon({
  glyph,
}: Readonly<{ glyph?: ToolSigilGlyph | undefined }>) {
  if (glyph === undefined) return <span>{" ".repeat(iconGutterWidth)}</span>;
  return <span fg={glyph.color}>{glyph.text}</span>;
}
