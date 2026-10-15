import type { InputRenderable, KeyEvent } from "@opentui/core";
import { useRef, useState } from "react";
import type { TuiPresentation } from "./presentation.js";
import { terminalText } from "./terminal-text.js";

/**
 * A Dialog's text or secret input. It is the Dialog's active input while
 * mounted; a secret is never drawn, only its length.
 */
export function Field({
  placeholder,
  secret = false,
  maxLength,
  onSubmit,
  onKeyDown,
  colors,
}: Readonly<{
  placeholder?: string | undefined;
  secret?: boolean | undefined;
  maxLength: number;
  onSubmit: (value: string) => void;
  /** Keys the input does not consume itself, e.g. Esc. */
  onKeyDown?: ((event: KeyEvent) => void) | undefined;
  colors: TuiPresentation["colors"];
}>) {
  const input = useRef<InputRenderable>(null);
  const [length, setLength] = useState(0);
  return (
    <box flexDirection="row" backgroundColor={colors.selection} paddingX={1}>
      {secret ? (
        <text fg={colors.selectionForeground}>
          {length === 0
            ? " "
            : `${"•".repeat(Math.min(length, 32))}  ${String(length)} characters`}
        </text>
      ) : null}
      {/* A secret's input stays focused but is never drawn. */}
      <box flexGrow={1} visible={!secret}>
        <input
          ref={input}
          width="100%"
          maxLength={maxLength}
          placeholder={terminalText(placeholder ?? "")}
          showCursor={!secret}
          selectable={!secret}
          focused
          onInput={(value) => {
            setLength(value.length);
          }}
          onSubmit={() => {
            onSubmit(input.current?.value ?? "");
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
          }}
          backgroundColor={colors.selection}
          focusedBackgroundColor={colors.selection}
          textColor={colors.selectionForeground}
          focusedTextColor={colors.selectionForeground}
          cursorColor={colors.accent}
        />
      </box>
    </box>
  );
}
