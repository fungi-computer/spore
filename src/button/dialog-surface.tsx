import { RGBA } from "@opentui/core";
import { useTerminalDimensions, type BoxProps } from "@opentui/react";
import { createContext, useContext } from "react";
import type { TuiPresentation } from "./presentation.js";

export const HostColorsContext = createContext<
  TuiPresentation["colors"] | undefined
>(undefined);

/** Dialogs and overlays inherit the palette of the host that contains them. */
export function useHostColors() {
  const colors = useContext(HostColorsContext);
  if (colors === undefined)
    throw new Error("Dialog content requires host colors");
  return colors;
}

/**
 * Place a temporary surface without moving history. Closing it restores
 * nothing: the focused pane's `useNativeFocus` re-asserts the active input.
 */
export function DialogSurface({
  children,
  colors,
  onClose,
}: Readonly<{
  children: BoxProps["children"];
  colors: TuiPresentation["colors"];
  onClose: () => void;
}>) {
  const { width, height } = useTerminalDimensions();
  return (
    <HostColorsContext.Provider value={colors}>
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        zIndex={100}
        alignItems="center"
        justifyContent="center"
        backgroundColor={RGBA.fromInts(0, 0, 0, 140)}
        onMouseDown={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <box
          width={Math.max(1, Math.min(68, width - 2))}
          maxHeight={Math.max(1, height - 2)}
          backgroundColor={colors.background}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <box
            backgroundColor={colors.background}
            paddingX={height < 14 ? 1 : 2}
            paddingY={height < 14 ? 0 : 1}
          >
            {children}
          </box>
        </box>
      </box>
    </HostColorsContext.Provider>
  );
}
