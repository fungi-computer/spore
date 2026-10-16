import {
  RGBA,
  SyntaxStyle,
  type EmbeddedTerminalRenderable,
} from "@opentui/core";
import { format } from "prettier/standalone";
import * as typescript from "prettier/plugins/typescript";
import * as estree from "prettier/plugins/estree";

export type ThemeColors = Readonly<
  Record<
    | "background"
    | "surface"
    | "selection"
    | "selectionForeground"
    | "foreground"
    | "primary"
    | "accent"
    | "success"
    | "info"
    | "warning"
    | "error",
    RGBA
  >
>;

export type TuiPresentation = ReturnType<typeof createPresentation>;

/** Keep missing outer palette values explicit until the native boundary. */
export type NativeTerminalDefaults = Readonly<{
  foreground: RGBA | undefined;
  background: RGBA | undefined;
}>;

function nativeDefaultColor(slot: 10 | 11, value: RGBA | undefined): string {
  // These maintained fallbacks restore OpenTUI's native defaults; they do not
  // claim to be the outer terminal's colors when its palette was unavailable.
  const color =
    value ??
    (slot === 10 ? RGBA.defaultForeground() : RGBA.defaultBackground());
  const [red, green, blue] = color.toInts();
  const hex = [red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("");
  return `\x1b]${String(slot)};#${hex}\x07`;
}

/** Set only the embedded terminal's native defaults, then redraw stored cells. */
export function applyNativeTerminalDefaults(
  terminal: Pick<EmbeddedTerminalRenderable, "write" | "invalidate">,
  defaults: NativeTerminalDefaults,
): void {
  terminal.write(
    nativeDefaultColor(10, defaults.foreground) +
      nativeDefaultColor(11, defaults.background),
  );
  terminal.invalidate();
}

export function createPresentation(
  colors: ThemeColors,
  terminal: boolean,
  nativeDefaults: NativeTerminalDefaults,
) {
  // Alpha is resolved against the current terminal snapshot by the renderer.
  const surface = RGBA.clone(colors.surface);
  surface.a = terminal ? 0.08 : 0.25;
  // Dim foreground remains theme-owned; alpha blends it against the row surface.
  const dimForeground = RGBA.clone(colors.foreground);
  dimForeground.a = 0.6;
  const syntax = SyntaxStyle.fromStyles({
    default: { fg: colors.foreground },
    "markup.heading": { fg: colors.foreground, bold: true },
    "markup.strong": { fg: colors.foreground, bold: true },
    "markup.italic": { fg: colors.foreground, italic: true },
    "markup.raw": { fg: colors.accent, bg: surface },
    "markup.link": { fg: colors.info, underline: true },
    "markup.list": { fg: colors.primary },
    "markup.quote": { fg: colors.foreground, italic: true },
    conceal: { fg: colors.surface },
    comment: { fg: colors.foreground, dim: true },
    keyword: { fg: colors.accent },
    string: { fg: colors.success },
    number: { fg: colors.warning },
    function: { fg: colors.info },
    type: { fg: colors.warning },
    operator: { fg: colors.accent },
  });
  return { colors, surface, syntax, dimForeground, nativeDefaults };
}

export type ToolCodeDisplay =
  | Readonly<{ status: "formatted"; content: string }>
  | Readonly<{
      status: "original";
      content: string;
      reason: "size-limit" | "format-unavailable";
    }>;

/** Formatting is display-only: failure preserves source, never logs to a TTY. */
export async function formatToolCode(
  content: string,
  width: number,
): Promise<ToolCodeDisplay> {
  if (content.length > 10_000)
    return { status: "original", content, reason: "size-limit" };
  try {
    const formatted = (
      await format(content, {
        parser: "typescript",
        plugins: [typescript, estree],
        printWidth: Math.max(20, width),
        singleQuote: true,
      })
    ).trimEnd();
    return { status: "formatted", content: formatted };
  } catch {
    // Incomplete input and printer failures are both ordinary display
    // outcomes. Neither can fail the tool or write over the terminal frame.
    return { status: "original", content, reason: "format-unavailable" };
  }
}
