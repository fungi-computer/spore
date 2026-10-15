import { RGBA } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BoxProps } from "@opentui/react";
import type { TuiPresentation } from "./presentation.js";
import { createSelectionCopy } from "./selection-copy.js";

export type CopyAction = (text: string) => void;
const CopyContext = createContext<CopyAction | undefined>(undefined);
export const copySurfaceColors = {
  background: RGBA.defaultBackground(),
  info: RGBA.fromIndex(4),
};

/** A link action uses the same clipboard and toast as mouse selection. */
export function useCopyAction(): CopyAction | undefined {
  return useContext(CopyContext);
}

/** The outermost surface owns copy for every view, including login and recovery. */
export function CopySurface({
  children,
  colors,
}: Readonly<{
  children: BoxProps["children"];
  colors: Pick<TuiPresentation["colors"], "background" | "info">;
}>) {
  const renderer = useRenderer();
  const clipboard = useMemo(() => createSelectionCopy(renderer), [renderer]);
  const [toast, setToast] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    return () => {
      clearTimeout(timer.current);
      void clipboard.dispose();
    };
  }, [clipboard]);
  const show = (message: string) => {
    clearTimeout(timer.current);
    setToast(message);
    timer.current = setTimeout(() => {
      setToast(undefined);
    }, 2_000);
  };
  const copy: CopyAction = (value) => {
    if (value.length === 0) return;
    void clipboard.copy(value).then(
      (result) => {
        show(
          result === "copied"
            ? "Copied to clipboard"
            : result === "sent"
              ? "Copy request sent to terminal"
              : "Clipboard unavailable · enable OSC 52",
        );
      },
      () => {
        show("Clipboard unavailable · enable OSC 52");
      },
    );
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
      position="relative"
      flexDirection="column"
      width="100%"
      height="100%"
      onMouseUp={copySelection}
    >
      {children}
      {toast === undefined ? null : (
        <box
          position="absolute"
          bottom={2}
          left={1}
          zIndex={200}
          backgroundColor={colors.background}
        >
          <text fg={colors.info}>● {toast}</text>
        </box>
      )}
    </box>,
  );
}
