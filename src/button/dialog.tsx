import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DialogSurface } from "./dialog-surface.js";
import type { TuiPresentation } from "./presentation.js";

type DialogHandle = Readonly<{
  dismiss: () => void;
  isCurrent: () => boolean;
}>;

type DialogEntry = Readonly<{
  key: number;
  render: (handle: DialogHandle) => ReactNode;
  handle: DialogHandle;
  onDismiss?: (() => void) | undefined;
  beforeDismiss?: (() => boolean) | undefined;
}>;

/** One client owns one dialog. Retired handles cannot close its replacement. */
export function useDialog(lifetime?: Readonly<{ address: string }> | string) {
  const [entry, setEntry] = useState<DialogEntry>();
  const current = useRef<DialogEntry | undefined>(undefined);
  const sequence = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    setEntry(current.current);
    return () => {
      mounted.current = false;
      const previous = current.current;
      current.current = undefined;
      previous?.onDismiss?.();
    };
  }, [lifetime]);
  const close = useCallback(() => {
    const previous = current.current;
    if (previous === undefined) return false;
    current.current = undefined;
    setEntry(undefined);
    previous.onDismiss?.();
    return true;
  }, []);
  const dismiss = useCallback(() => {
    const previous = current.current;
    if (previous === undefined) return false;
    if (previous.beforeDismiss?.() !== false) close();
    return true;
  }, [close]);
  const show = useCallback(
    (
      render: DialogEntry["render"],
      options?: Readonly<{
        onDismiss?: () => void;
        beforeDismiss?: () => boolean;
      }>,
    ): DialogHandle => {
      const handle: DialogHandle = {
        isCurrent: () => mounted.current && current.current?.handle === handle,
        dismiss: () => {
          // The dialog's own completion closes it; user dismissal goes through
          // beforeDismiss so an owned save/cancellation can finish first.
          if (handle.isCurrent()) close();
        },
      };
      if (!mounted.current) return handle;
      const previous = current.current;
      if (previous?.beforeDismiss?.() === false)
        throw new Error("The current dialog is still saving or closing.");
      const next = {
        key: ++sequence.current,
        render,
        handle,
        onDismiss: options?.onDismiss,
        beforeDismiss: options?.beforeDismiss,
      };
      current.current = next;
      setEntry(next);
      previous?.onDismiss?.();
      return handle;
    },
    [close],
  );
  return { show, dismiss, isOpen: entry !== undefined, entry };
}

export type DialogController = ReturnType<typeof useDialog>;

/** Keep the surface mounted across replacements so focus returns only on close. */
export function DialogHost({
  dialog,
  colors,
}: Readonly<{
  dialog: ReturnType<typeof useDialog>;
  colors: TuiPresentation["colors"];
}>) {
  const entry = dialog.entry;
  if (entry === undefined) return null;
  return (
    <DialogSurface colors={colors} onClose={dialog.dismiss}>
      <DialogContent key={entry.key} entry={entry} />
    </DialogSurface>
  );
}

function DialogContent({ entry }: Readonly<{ entry: DialogEntry }>) {
  return <>{entry.render(entry.handle)}</>;
}
