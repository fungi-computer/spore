import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import {
  useNativeFocus,
  usePaneKit,
  usePanePaste,
} from "../../button/index.js";
import { useEffect, useMemo, useRef } from "react";
import type { TuiPresentation } from "../../button/index.js";
import type { TerminalInputHandoff } from "../../button/index.js";

export type TerminalComposerProps = Readonly<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onKeyDown?: (event: KeyEvent) => void;
  focused: boolean;
  readOnly?: boolean;
  inputHandoff?: TerminalInputHandoff | undefined;
  maxHeight: number;
  colors: TuiPresentation["colors"];
}>;

/** Keep Parakeet's draft in the native editor without resetting its cursor. */
export function TerminalComposer({
  value,
  onChange,
  onSubmit,
  onKeyDown,
  focused,
  readOnly = false,
  inputHandoff,
  maxHeight,
  colors,
}: TerminalComposerProps) {
  const editor = useRef<TextareaRenderable>(null);
  const { rendering } = usePaneKit();
  useEffect(() => {
    if (editor.current && editor.current.plainText !== value) {
      editor.current.setText(value);
      // A draft replaced from outside (completion, history) continues at its end.
      editor.current.gotoBufferEnd();
    }
  }, [value]);
  const deliver = useMemo(
    () =>
      inputHandoff === undefined
        ? undefined
        : (renderable: TextareaRenderable) => {
            inputHandoff.deliver(renderable);
          },
    [inputHandoff],
  );
  // After the draft sync above, so input handed over at activation is not
  // overwritten by a stale draft.
  const active = useNativeFocus(editor, { enabled: focused, deliver });
  usePanePaste((event) => {
    const current = editor.current;
    if (!active || current === null) return;
    if (readOnly) {
      event.preventDefault();
      return;
    }
    if (rendering.isFocused(current)) return;
    // Global paste handlers run before renderable handlers. A transient focus
    // loss must not discard a whole bracketed paste in an idle conversation.
    event.preventDefault();
    current.focus();
    current.handlePaste(event);
  });
  return (
    <textarea
      ref={editor}
      initialValue={value}
      flexGrow={1}
      flexShrink={1}
      minHeight={1}
      maxHeight={maxHeight}
      wrapMode="word"
      onContentChange={() => {
        const text = editor.current?.plainText;
        if (text !== undefined && text !== value) onChange(text);
      }}
      onSubmit={() => {
        if (readOnly) return;
        // Enter can share an input burst with a bracketed paste. Flush the
        // native editor before the slash controller reads the draft.
        const text = editor.current?.plainText;
        if (text !== undefined && text !== value) onChange(text);
        queueMicrotask(onSubmit);
      }}
      onKeyDown={(event) => {
        if (readOnly) {
          event.preventDefault();
          return;
        }
        // Recall needs the current native buffer. Ordinary typing must not
        // publish a pre-keystroke value that can overwrite the next character.
        if (event.name === "up") {
          const text = editor.current?.plainText;
          if (text !== undefined && text !== value) onChange(text);
        }
        onKeyDown?.(event);
      }}
      keyBindings={[
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "linefeed", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "return", meta: true, action: "newline" },
      ]}
      placeholder="Ask anything… (/ for commands)"
      backgroundColor="transparent"
      focusedBackgroundColor="transparent"
      textColor={colors.foreground}
      focusedTextColor={colors.foreground}
      cursorColor={colors.accent}
      selectionBg={colors.selection}
      selectionFg={colors.selectionForeground}
    />
  );
}
