import { HostColorsContext } from "../button/dialog-surface.js";
import { NoticeLine } from "../button/notice.js";
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
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import { builtinPanes } from "../panes/builtins.js";
import {
  DialogHost,
  reportFailure,
  type DialogController,
  useTerminalTheme,
  type PaneSessions,
  type PaneApps,
  type ThemeName,
  type PaneNotice,
  type PaneKindEntry,
} from "../button/index.js";
import {
  usePaneShellCommands,
  type PaneShellCommandOptions,
} from "./commands.js";
import { displayText } from "./display-text.js";
import { paneValue } from "./value.js";
import { createPaneRegistry, type PaneProjection } from "./registry.js";

export type PaneWorkspaceProps = Readonly<{
  kinds?: readonly PaneKindEntry[];
  /** Host-admitted kinds registered beside the builtins, such as installed programs. */
  additionalKinds?: readonly PaneKindEntry[] | undefined;
  commandHost: AppSurfaceCommandHost;
  sessions: PaneSessions;
  apps?: PaneApps | undefined;
  theme: ThemeName;
  exit: () => void;
  openPane: () => void | Promise<void>;
  dialog: DialogController;
  onRegistry: (registry: ReturnType<typeof createPaneRegistry>) => void;
}>;

/** One shell renderer reads the registry; hidden tiles keep their React lifetime. */
export function PaneWorkspace(props: PaneWorkspaceProps) {
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
  const [notice, setNotice] = useState<PaneNotice>();
  const notify = (next: PaneNotice) => {
    setNotice({ ...next, message: displayText(next.message) });
  };
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
      notify,
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
  // Only a Dialog is modal; a notice never holds the keyboard. A layout
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
    notify,
  };
  const leaderKey = usePaneShellCommands(shellCommands);
  useEffect(() => {
    // A notice is read, not answered: the next key (Esc included, which a
    // keymap binding may consume first) dismisses it and still reaches its owner.
    const dismiss = () => {
      setNotice(undefined);
    };
    renderer.keyInput.prependListener("keypress", dismiss);
    return () => {
      renderer.keyInput.off("keypress", dismiss);
    };
  }, [renderer]);
  useKeyboard((event) => {
    if (leaderKey(event)) {
      event.preventDefault();
      event.stopPropagation();
    } else registry.key(event);
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
        {notice === undefined ? null : (
          <box
            position="absolute"
            bottom={0}
            left={0}
            width="100%"
            height="auto"
            backgroundColor={chrome.colors.background}
          >
            <NoticeLine notice={notice} colors={chrome.colors} />
          </box>
        )}
        <DialogHost dialog={dialog} colors={chrome.colors} />
      </box>
    </HostColorsContext.Provider>
  );
}
