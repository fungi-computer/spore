import type { InputRenderable, KeyEvent } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
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
  initialValue = "",
  value,
  focused = true,
  onInput,
  onSubmit,
  onKeyDown,
  colors,
}: Readonly<{
  placeholder?: string | undefined;
  secret?: boolean | undefined;
  maxLength: number;
  /** Text the input starts with, e.g. a draft kept across a remount. */
  initialValue?: string | undefined;
  /** Text owned elsewhere; the input follows it when it changes under the person's hands. */
  value?: string | undefined;
  /** Whether the input holds the keys; a field that stays mounted gives them up. */
  focused?: boolean | undefined;
  onInput?: ((value: string) => void) | undefined;
  onSubmit: (value: string) => void;
  /** Keys the input does not consume itself, e.g. Esc. */
  onKeyDown?: ((event: KeyEvent) => void) | undefined;
  colors: TuiPresentation["colors"];
}>) {
  const input = useRef<InputRenderable>(null);
  const [length, setLength] = useState((value ?? initialValue).length);
  useEffect(() => {
    const native = input.current;
    if (value === undefined || native === null || native.value === value)
      return;
    native.value = value;
    setLength(value.length);
  }, [value]);
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
          value={value ?? initialValue}
          placeholder={terminalText(placeholder ?? "")}
          showCursor={!secret}
          selectable={!secret}
          focused={focused}
          onInput={(value) => {
            setLength(value.length);
            onInput?.(value);
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
