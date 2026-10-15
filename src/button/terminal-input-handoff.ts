import {
  KeyEvent,
  PasteEvent,
  type KeyHandler,
  type TextareaRenderable,
} from "@opentui/core";

const maximumBufferedBytes = 256 * 1_024;
const overflowNotice =
  "Fungi could not keep all of your early input. Please paste it again.";

type BufferedInput =
  | Readonly<{ type: "key"; event: KeyEvent }>
  | Readonly<{ type: "paste"; event: PasteEvent }>;

const isDraftKey = (key: KeyEvent) =>
  !key.ctrl &&
  !key.meta &&
  (key.name.length === 1 ||
    key.name === "space" ||
    key.name === "return" ||
    key.name === "kpenter" ||
    key.name === "linefeed" ||
    key.name === "backspace" ||
    key.name === "tab");

/** Retain terminal input while the composer is being mounted or restored. */
export function createTerminalInputHandoff(keyInput: KeyHandler) {
  let capturing = true;
  let bytes = 0;
  let overflowed = false;
  const pending: BufferedInput[] = [];
  const hold = (size: number, input: BufferedInput) => {
    bytes += size;
    if (bytes > maximumBufferedBytes) {
      overflowed = true;
      pending.length = 0;
      return;
    }
    if (!overflowed) pending.push(input);
  };
  const onKey = (key: KeyEvent) => {
    if (!capturing || !isDraftKey(key)) return;
    key.preventDefault();
    key.stopPropagation();
    hold(Buffer.byteLength(key.raw), { type: "key", event: new KeyEvent(key) });
  };
  const onPaste = (event: PasteEvent) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    hold(event.bytes.byteLength, {
      type: "paste",
      event: new PasteEvent(event.bytes.slice(), event.metadata),
    });
  };
  keyInput.on("keypress", onKey);
  keyInput.on("paste", onPaste);
  return {
    capture: () => {
      capturing = true;
    },
    pause: () => {
      capturing = false;
    },
    deliver: (editor: TextareaRenderable) => {
      capturing = false;
      editor.focus();
      if (overflowed) editor.setText(overflowNotice);
      else
        for (const item of pending) {
          if (item.type === "paste") editor.handlePaste(item.event);
          else editor.handleKeyPress(item.event);
        }
      pending.length = 0;
      bytes = 0;
      overflowed = false;
    },
    close: () => {
      keyInput.off("keypress", onKey);
      keyInput.off("paste", onPaste);
      pending.length = 0;
    },
  };
}

export type TerminalInputHandoff = ReturnType<
  typeof createTerminalInputHandoff
>;
