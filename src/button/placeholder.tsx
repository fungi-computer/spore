import type { TuiPresentation } from "./presentation.js";
import { toneColor } from "./tone.js";

export type PlaceholderState = "loading" | "empty" | "error" | "signed-out";

/**
 * What a surface shows instead of its content: loading, empty, an error, or
 * a signed-out state naming its one action.
 */
export function Placeholder({
  state,
  message,
  action,
  colors,
}: Readonly<{
  state: PlaceholderState;
  message: string;
  /** The one next step, e.g. "Run /login and choose Fungi". */
  action?: string | undefined;
  colors: TuiPresentation["colors"];
}>) {
  const tone =
    state === "error" ? "error" : state === "signed-out" ? "warning" : "muted";
  return (
    <box flexDirection="column">
      <text fg={toneColor(colors, tone)}>{message}</text>
      {action === undefined ? null : (
        <text fg={colors.foreground} attributes={2}>
          {action}
        </text>
      )}
    </box>
  );
}
