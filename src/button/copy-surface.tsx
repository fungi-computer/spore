import { useKeyboard, useRenderer } from "@opentui/react";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { createSelectionCopy } from "./selection-copy.js";
import { ToastProvider, useToast } from "./toast.js";

export type CopyAction = (text: string) => void;
const CopyContext = createContext<CopyAction | undefined>(undefined);

/** A link action uses the same clipboard and toast as mouse selection. */
export function useCopyAction(): CopyAction | undefined {
  return useContext(CopyContext);
}

/**
 * The outermost surface owns copy and toasts for every view, including login
 * and recovery.
 */
export function CopySurface({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <box position="relative" flexDirection="column" width="100%" height="100%">
      <ToastProvider>
        <CopyHost>{children}</CopyHost>
      </ToastProvider>
    </box>
  );
}

function CopyHost({ children }: Readonly<{ children: ReactNode }>) {
  const renderer = useRenderer();
  const toast = useToast();
  const clipboard = useMemo(() => createSelectionCopy(renderer), [renderer]);
  useEffect(() => {
    return () => {
      void clipboard.dispose();
    };
  }, [clipboard]);
  const copy: CopyAction = (value) => {
    if (value.length === 0) return;
    const unavailable = () => {
      toast.show({
        variant: "warning",
        message: "Clipboard unavailable · enable OSC 52",
      });
    };
    void clipboard.copy(value).then((result) => {
      // A completed copy only echoes what the person just did.
      if (result === "sent")
        toast.show({
          variant: "info",
          message: "Copy request sent to terminal",
        });
      else if (result === "failed") unavailable();
    }, unavailable);
  };
  const copySelection = () => {
    const selected = renderer.getSelection()?.getSelectedText();
    if (!selected) return;
    queueMicrotask(() => {
      if (!renderer.isDestroyed) renderer.clearSelection();
    });
    copy(selected);
  };
  useKeyboard((key) => {
    if ((key.meta || key.option) && key.name === "c") {
      const selected = renderer.getSelection()?.getSelectedText();
      if (selected) {
        key.preventDefault();
        copy(selected);
      }
    }
  });
  return createElement(
    CopyContext.Provider,
    { value: copy },
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      onMouseUp={copySelection}
    >
      {children}
    </box>,
  );
}
