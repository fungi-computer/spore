import { HostColorsContext } from "../button/dialog-surface.js";
import { Placeholder } from "../button/placeholder.js";
import {
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { CliRenderEvents } from "@opentui/core";
import {
  useEffect,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import { builtinPanes } from "../panes/builtins.js";
import {
  DialogHost,
  reportFailure,
  type DialogController,
  useTerminalTheme,
  type PaneSessions,
  type PaneApps,
  type ThemeName,
  type PaneKindEntry,
  useToast,
  ToastProvider,
} from "../button/index.js";
import {
  usePaneShellCommands,
  type PaneShellCommandOptions,
} from "./commands.js";
import { paneValue } from "./value.js";
import {
  createPaneRegistry,
  type PaneProjection,
  type PaneOpenDirection,
} from "./registry.js";
import { KeyHintsContext } from "./which-key.js";

export type PaneWorkspaceProps = Readonly<{
  kinds?: readonly PaneKindEntry[];
  /** Host-admitted kinds registered beside the builtins, such as installed programs. */
  additionalKinds?: readonly PaneKindEntry[] | undefined;
  commandHost: AppSurfaceCommandHost;
  sessions: PaneSessions;
  apps?: PaneApps | undefined;
  theme: ThemeName;
  exit: () => void;
  openPane: (direction?: PaneOpenDirection) => void | Promise<void>;
  dialog: DialogController;
  onRegistry: (registry: ReturnType<typeof createPaneRegistry>) => void;
}>;

/**
 * One shell renderer reads the registry; hidden tiles keep their React
 * lifetime. Toasts float over it, owned by the application root when there is
 * one and by the workspace when it is mounted alone.
 */
export function PaneWorkspace(props: PaneWorkspaceProps) {
  return (
    <box width="100%" height="100%" position="relative">
      <ToastProvider>
        <PaneWorkspaceBody {...props} />
      </ToastProvider>
    </box>
  );
}

function PaneWorkspaceBody(props: PaneWorkspaceProps) {
  const keyHints = useContext(KeyHintsContext);
  const renderer = useRenderer();
  const viewport = useTerminalDimensions();
  const dialog = props.dialog;
  // Shared shell colors follow the pane's confirmed palette, without a
  // second query for the same transition.
  const presentation = useTerminalTheme(props.theme, {
    refreshOnReturnToTerminal: false,
  });
  const themePresentation = useMemo(
    () => ({
      colors: presentation.colors,
      surface: presentation.surface,
      syntax: presentation.syntax,
      dimForeground: presentation.dimForeground,
      nativeDefaults: presentation.nativeDefaults,
    }),
    [
      presentation.colors,
      presentation.surface,
      presentation.syntax,
      presentation.dimForeground,
      presentation.nativeDefaults,
    ],
  );
  const toast = useToast();
  const [stores] = useState(() => ({
    theme: paneValue(themePresentation),
    open: paneValue(dialog.isOpen),
    dialog: { current: dialog },
  }));
  stores.dialog.current = dialog;
  const [registry] = useState(() =>
    createPaneRegistry({
      kinds: props.kinds ?? [...builtinPanes, ...(props.additionalKinds ?? [])],
      commands: props.commandHost,
      viewport,
      minima: { width: 40, height: 12 },
      sessions: props.sessions,
      apps: props.apps,
      theme: stores.theme.value,
      exit: props.exit,
      toast: toast.show,
      dialogs: {
        open: stores.open.value,
        show: (...args) => stores.dialog.current.show(...args),
        dismiss: () => stores.dialog.current.dismiss(),
      },
      rendering: {
        afterFrame: (callback) => {
          renderer.once(CliRenderEvents.FRAME, callback);
          return () => {
            renderer.off(CliRenderEvents.FRAME, callback);
          };
        },
        requestFrame: () => {
          renderer.requestRender();
        },
        isFocused: (renderable) =>
          renderer.currentFocusedRenderable === renderable,
      },
    }),
  );
  useEffect(() => {
    stores.theme.set(themePresentation);
  }, [stores, themePresentation]);
  // Only a Dialog is modal; a toast never holds the keyboard. A layout
  // effect: panes must see a Dialog as open before their own passive effects
  // run in the commit that shows it.
  useLayoutEffect(() => {
    stores.open.set(dialog.isOpen);
  }, [stores, dialog.isOpen]);
  useEffect(() => {
    registry.viewport(viewport);
  }, [registry, viewport.width, viewport.height]);
  useEffect(() => {
    props.onRegistry(registry);
    return () => {
      void registry.dispose().catch((cause: unknown) => {
        return reportFailure("pane-workspace-close", cause);
      });
    };
  }, [registry, props.onRegistry]);
  const shellCommands: PaneShellCommandOptions = {
    registry,
    host: props.commandHost,
    dialog,
    colors: presentation.colors,
    openPane: props.openPane,
    toast: toast.show,
  };
  usePaneShellCommands(shellCommands);
  useKeyboard((event) => {
    registry.key(event);
  });
  usePaste((event) => {
    registry.paste(event);
  });
  const panes: readonly PaneProjection[] = useSyncExternalStore(
    registry.subscribe,
    registry.read,
  );
  const multiple = panes.length > 1;
  const chrome =
    panes.find((pane) => pane.focused)?.presentation ?? presentation;
  return (
    <HostColorsContext.Provider value={chrome.colors}>
      <box width="100%" height="100%" position="relative">
        {panes.length === 0 ? (
          <Placeholder
            state="empty"
            message="No panes open. Ctrl K: pane commands · Ctrl C: exit."
            colors={chrome.colors}
          />
        ) : null}
        {panes.map((pane) => (
          <box
            key={pane.paneId}
            position="absolute"
            visible={pane.visible}
            border={
              multiple &&
              !pane.zoomed &&
              pane.frame.x + pane.frame.width < viewport.width
                ? ["right"]
                : []
            }
            borderColor={chrome.colors.surface}
            left={pane.frame.x}
            top={pane.frame.y}
            width={pane.frame.width}
            height={pane.frame.height}
            onMouseDown={() => {
              registry.focus(pane.paneId);
            }}
          >
            {pane.state === "loading" ? (
              <Placeholder
                state="loading"
                message={`Opening ${pane.focused ? "▸ " : "  "}${pane.title}${pane.zoomed ? " · zoomed" : ""}…`}
                colors={chrome.colors}
              />
            ) : (
              pane.node
            )}
          </box>
        ))}
        {keyHints}
        <DialogHost dialog={dialog} colors={chrome.colors} />
      </box>
    </HostColorsContext.Provider>
  );
}
