import type { PaneTone } from "./index.js";
import type { TuiPresentation } from "./presentation.js";

/** The one tone → color mapping for Button's lines. */
export function toneColor(colors: TuiPresentation["colors"], tone: PaneTone) {
  switch (tone) {
    case "info":
      return colors.info;
    case "success":
      return colors.success;
    case "warning":
      return colors.warning;
    case "error":
      return colors.error;
    case "muted":
      return colors.foreground;
  }
}
