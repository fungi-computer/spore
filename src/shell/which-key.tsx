import { useActiveKeys, usePendingSequence } from "@opentui/keymap/react";
import {
  createContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { AppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import { useHostColors } from "../button/dialog-surface.js";
import { displayText } from "./display-text.js";

/** The native application supplies hints; a keymap-disabled workspace has none. */
export const KeyHintsContext = createContext<ReactNode>(null);

/** A nonmodal view of the maintained keymap's pending continuations. */
export function WhichKeyStrip({
  host,
}: Readonly<{ host: AppSurfaceCommandHost }>) {
  const pending = usePendingSequence();
  const keys = useActiveKeys();
  const snapshot = useSyncExternalStore(host.subscribe, host.active);
  const colors = useHostColors();
  const [visible, setVisible] = useState(false);
  const armed = pending.length > 0;
  useEffect(() => {
    if (!armed) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => {
      setVisible(true);
    }, 200);
    return () => {
      clearTimeout(timer);
    };
  }, [armed]);
  if (!armed || !visible) return null;
  const rows = keys.map((key) => {
    const command = snapshot.bindings.find(
      (row) => row.commandId === key.command,
    );
    return {
      key: key.display,
      title: command?.title ?? (key.continues ? "…" : ""),
    };
  });
  return (
    <box
      position="absolute"
      bottom={0}
      left={0}
      width="100%"
      flexDirection="row"
      flexWrap="wrap"
      backgroundColor={colors.background}
      zIndex={50}
    >
      {rows.map((row) => (
        <text key={row.key} fg={colors.foreground}>
          {`${row.key} ${displayText(row.title)}  `}
        </text>
      ))}
    </box>
  );
}
