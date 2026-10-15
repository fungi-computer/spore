import { terminalCellWidth as stringWidth } from "../../button/index.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const runTailWidth = 14;

/** Keep both ends of a target without splitting a grapheme or a wide cell. */
export function fitRunTarget(text: string, width: number): string {
  const line = text.replace(/\s+/gu, " ");
  if (stringWidth(line) <= width) return line;
  if (width <= 0) return "";
  const budget = width - 1;
  const leftBudget = Math.ceil(budget / 2);
  const parts = Array.from(graphemes.segment(line), ({ segment }) => segment);
  let left = "";
  let right = "";
  let first = 0;
  let last = parts.length - 1;
  while (first <= last) {
    const part = parts[first];
    if (part === undefined || stringWidth(left + part) > leftBudget) break;
    left += part;
    first += 1;
  }
  const rightBudget = budget - stringWidth(left);
  while (last >= first) {
    const part = parts[last];
    if (part === undefined || stringWidth(part + right) > rightBudget) break;
    right = part + right;
    last -= 1;
  }
  return `${left}…${right}`;
}
