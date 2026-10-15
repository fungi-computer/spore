import type { PaneNotice } from "./index.js";
import type { TuiPresentation } from "./presentation.js";
import { toneColor } from "./tone.js";

/**
 * A Notice: one non-modal line in its tone. It never holds the keyboard; its
 * owner clears it (the shell's on the next key).
 */
export function NoticeLine({
  notice,
  colors,
}: Readonly<{
  notice: Pick<PaneNotice, "message"> &
    Readonly<{ tone: PaneNotice["tone"] | "muted" }>;
  colors: TuiPresentation["colors"];
}>) {
  return (
    <text height={1} fg={toneColor(colors, notice.tone)}>
      {notice.message}
    </text>
  );
}
