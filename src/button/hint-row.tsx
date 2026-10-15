import type { KeyHint } from "@fungi.computer/parakeet/headless";
import { stringWidth } from "bun";
import type { TuiPresentation } from "./presentation.js";

const separator = " · ";

function hintText(hint: KeyHint, compact = false) {
  return compact ? hint.keys : `${hint.keys} ${hint.label}`;
}

/**
 * The hints that fit `width` cells: lowest-priority entries drop first, and
 * the survivors keep their display order.
 */
export function fitHints(
  hints: readonly KeyHint[],
  width: number,
  compact = false,
): readonly KeyHint[] {
  const kept = [...hints];
  const fits = () =>
    stringWidth(kept.map((hint) => hintText(hint, compact)).join(separator)) <=
    Math.max(0, width);
  while (kept.length > 0 && !fits()) {
    let drop = 0;
    for (let index = 1; index < kept.length; index += 1)
      if ((kept[index]?.priority ?? 0) >= (kept[drop]?.priority ?? 0))
        drop = index;
    kept.splice(drop, 1);
  }
  return kept;
}

/**
 * Key hints for a Dialog or an inspection header; never the footer. Drawn as
 * the dim caption every Button dialog already uses.
 */
export function HintRow({
  hints,
  width,
  colors,
  marginTop,
  compact = false,
}: Readonly<{
  hints: readonly KeyHint[];
  width: number;
  /** Keys only, for narrow or short terminals. */
  compact?: boolean;
  colors: TuiPresentation["colors"];
  marginTop?: number;
}>) {
  const shown = fitHints(hints, width, compact);
  if (shown.length === 0) return null;
  return (
    <text
      fg={colors.foreground}
      attributes={2}
      wrapMode="none"
      marginTop={marginTop ?? 0}
    >
      {shown.map((hint) => hintText(hint, compact)).join(separator)}
    </text>
  );
}
