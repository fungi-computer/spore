import { sigilGutterText } from "../src/button/index.js";

/**
 * The footer row showing one status word, e.g. `● idle` or `● compacting`.
 * The status dot leads the row's own text, centered in the shared gutter.
 */
export function footerRow(frame: string, label: string): string | undefined {
  return frame
    .split("\n")
    .find((line) => line.includes(`${sigilGutterText("●")}${label}`));
}
