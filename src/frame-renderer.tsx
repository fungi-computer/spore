import { HostColorsContext, useHostColors } from "./button/dialog-surface.js";
import type { createRoot } from "@opentui/react";
import type { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { DialogHost, useDialog } from "./button/dialog.js";
import {
  TuiWorkspace,
  type TuiFrameProps,
  type TuiWorkspaceEntry,
  type TuiWorkspaceConfiguration,
  workspaceConfiguration,
} from "./frame.js";
import {
  SessionPickerContent,
  type SessionPickerProps,
} from "./session-picker.js";
import { Picker } from "./button/picker.js";
import { useTerminalTheme } from "./button/terminal-theme.js";
import { CopySurface, copySurfaceColors } from "./button/copy-surface.js";
import { Placeholder } from "./button/placeholder.js";

type FrameProjection = Readonly<{
  entries?: readonly TuiWorkspaceEntry[];
  configuration?: TuiWorkspaceConfiguration;
  queryClient?: QueryClient;
  requested?: number;
  picker?: SessionPickerProps;
  recovery?: Readonly<{ message: string; retry: () => void; exit: () => void }>;
  serviceMismatch?: Readonly<{
    message: string;
    upgrade: (() => void) | undefined;
    exit: () => void;
  }>;
}>;
type FrameStore = Readonly<{
  read: () => FrameProjection;
  subscribe: (listener: () => void) => () => void;
  update: (projection: FrameProjection) => void;
}>;
const mountedFrames = new WeakMap<ReturnType<typeof createRoot>, FrameStore>();

function MountedFrame({ store }: Readonly<{ store: FrameStore }>) {
  return (
    <CopySurface colors={copySurfaceColors}>
      <MountedFrameContent store={store} />
    </CopySurface>
  );
}

function MountedFrameContent({ store }: Readonly<{ store: FrameStore }>) {
  const projection = useSyncExternalStore(store.subscribe, store.read);
  const entries = projection.entries;
  const initialPresentation = useTerminalTheme(
    projection.picker?.initialTheme ??
      projection.configuration?.initialTheme ??
      "terminal",
  );
  const dialog = useDialog();
  useEffect(() => {
    const picker = projection.picker;
    if (picker === undefined) return;
    const handle = dialog.show(
      (active) => (
        <SessionPickerContent
          {...picker}
          onSelect={(index) => {
            picker.onSelect(index);
            active.dismiss();
          }}
          onCancel={active.dismiss}
        />
      ),
      {
        onDismiss: () => {
          if (store.read().picker === picker) {
            const selected = { ...store.read() };
            delete selected.picker;
            store.update(selected);
          }
          picker.onCancel();
        },
      },
    );
    return () => {
      handle.dismiss();
    };
  }, [projection.picker, dialog.show, store]);
  // Over a live workspace, recovery and a build mismatch are Dialogs: the
  // one modal surface, drawn and dismissed like every other.
  const live = entries !== undefined && projection.queryClient !== undefined;
  const recovery = live ? projection.recovery : undefined;
  const mismatch = live ? projection.serviceMismatch : undefined;
  useEffect(() => {
    if (recovery === undefined) return;
    const handle = dialog.show(() => <ConnectionRecovery {...recovery} />, {
      // Leaving recovery is a choice in the dialog, not Esc.
      beforeDismiss: () => false,
    });
    return () => {
      handle.dismiss();
    };
  }, [recovery, dialog.show]);
  useEffect(() => {
    if (mismatch === undefined) return;
    const handle = dialog.show(() => <ServiceMismatch {...mismatch} />, {
      onDismiss: () => {
        if (store.read().serviceMismatch === mismatch) mismatch.exit();
      },
    });
    return () => {
      handle.dismiss();
    };
  }, [mismatch, dialog.show, store]);
  if (entries === undefined && projection.recovery !== undefined)
    return (
      <HostColorsContext.Provider value={initialPresentation.colors}>
        <ConnectionRecovery {...projection.recovery} />
      </HostColorsContext.Provider>
    );
  if (entries === undefined && projection.serviceMismatch !== undefined)
    return (
      <HostColorsContext.Provider value={initialPresentation.colors}>
        <ServiceMismatch {...projection.serviceMismatch} />
      </HostColorsContext.Provider>
    );
  if (entries === undefined || projection.queryClient === undefined)
    return (
      <box flexDirection="column" flexGrow={1}>
        <Placeholder
          state="loading"
          message="Connecting to Local Shiitake… Ctrl+C to exit."
          colors={initialPresentation.colors}
        />
        {dialog.isOpen ? (
          <InitialDialog dialog={dialog} colors={initialPresentation.colors} />
        ) : null}
      </box>
    );
  return (
    <QueryClientProvider client={projection.queryClient}>
      <TuiWorkspace
        entries={entries}
        configuration={projection.configuration}
        requested={projection.requested ?? 0}
        dialog={dialog}
      />
    </QueryClientProvider>
  );
}

function ServiceMismatch({
  message,
  upgrade,
  exit,
}: Readonly<{
  message: string;
  upgrade: (() => void) | undefined;
  exit: () => void;
}>) {
  const colors = useHostColors();
  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={colors.warning}>{message}</text>
      <Picker
        title="Client and service builds differ"
        colors={colors}
        choices={
          upgrade === undefined
            ? [{ name: "Exit this client" }]
            : [
                { name: "Upgrade service and reopen Session" },
                { name: "Exit this client" },
              ]
        }
        onSelect={(index) => {
          if (index === 0 && upgrade !== undefined) upgrade();
          else exit();
        }}
        onCancel={exit}
      />
      <text>
        Your saved conversation and running turns stay with the service.
      </text>
    </box>
  );
}

export function renderTuiServiceMismatch(
  root: ReturnType<typeof createRoot>,
  message: string,
  upgrade: (() => void) | undefined,
  exit: () => void,
) {
  const store = frameStore(root);
  store.update({
    ...store.read(),
    serviceMismatch: { message, upgrade, exit },
  });
}

function ConnectionRecovery({
  message,
  retry,
  exit,
}: Readonly<{ message: string; retry: () => void; exit: () => void }>) {
  const colors = useHostColors();
  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={colors.error}>{message}</text>
      <Picker
        title="Connection unavailable"
        colors={colors}
        choices={[{ name: "Retry connection" }, { name: "Exit" }]}
        onSelect={(index) => {
          if (index === 0) retry();
          else if (index === 1) exit();
        }}
        onCancel={() => undefined}
      />
      <text>Ctrl+C exits. Your saved conversations are unchanged.</text>
    </box>
  );
}

export function renderTuiConnectionRecovery(
  root: ReturnType<typeof createRoot>,
  error: Error,
  retry: () => void,
  exit: () => void,
) {
  const store = frameStore(root);
  store.update({
    ...store.read(),
    recovery: { message: error.message, retry, exit },
  });
}

function InitialDialog({
  dialog,
  colors,
}: Readonly<{
  dialog: ReturnType<typeof useDialog>;
  colors: ReturnType<typeof useTerminalTheme>["colors"];
}>) {
  return <DialogHost dialog={dialog} colors={colors} />;
}

/** OpenTUI root.render creates a container; invoke it once per application. */
function frameStore(root: ReturnType<typeof createRoot>): FrameStore {
  const existing = mountedFrames.get(root);
  if (existing !== undefined) return existing;
  let current: FrameProjection = {};
  const listeners = new Set<() => void>();
  const store: FrameStore = {
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next) => {
      current = next;
      for (const listener of listeners) listener();
    },
  };
  mountedFrames.set(root, store);
  root.render(<MountedFrame store={store} />);
  return store;
}

export function renderTuiConnecting(root: ReturnType<typeof createRoot>): void {
  frameStore(root).update({});
}

export function renderTuiConversation(
  root: ReturnType<typeof createRoot>,
  queryClient: QueryClient,
  props: TuiFrameProps,
): void {
  const store = frameStore(root);
  const previous = store.read();
  const request = (previous.requested ?? 0) + 1;
  const entries =
    previous.entries?.filter(
      (entry) => entry.props.session.address !== props.session.address,
    ) ?? [];
  store.update({
    entries: [
      ...entries,
      {
        props: {
          ...props,
          onClose: () => {
            const live = store.read();
            store.update({
              ...live,
              entries:
                live.entries?.filter(
                  (entry) =>
                    entry.props.session.address !== props.session.address,
                ) ?? [],
            });
            return props.onClose?.();
          },
        },
        request,
      },
    ],
    configuration: previous.configuration ?? workspaceConfiguration(props),
    queryClient,
    requested: request,
  });
}

/** Session selection overlays the current conversation until replacement succeeds. */
export function renderTuiSessionPicker(
  root: ReturnType<typeof createRoot>,
  props: SessionPickerProps,
): void {
  const store = frameStore(root);
  store.update({ ...store.read(), picker: props });
}
