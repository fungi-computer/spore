import type { ToastInput } from "../../button/index.js";

/** Local PTY admission failures are attention, not a confirmation of typed keys. */
export function terminalControls(
  terminal: Readonly<{
    live: boolean;
    input: (data: Uint8Array) => boolean;
    resize: (cols: number, rows: number) => boolean;
  }>,
  toast: (input: ToastInput) => void,
) {
  return {
    input(data: Uint8Array) {
      if (!terminal.input(data))
        toast({
          key: "terminal-input",
          variant: "error",
          duration: "until-dismissed",
          message: terminal.live
            ? "Local terminal input was not sent; retry with a smaller paste"
            : "Local terminal input was not sent; the program has ended",
        });
    },
    resize(cols: number, rows: number) {
      if (!terminal.resize(cols, rows))
        toast({
          key: "terminal-resize",
          variant: "error",
          duration: "until-dismissed",
          message: "Local terminal resize was not sent",
        });
    },
  };
}
