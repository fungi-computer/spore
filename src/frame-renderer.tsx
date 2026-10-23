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
import { CopySurface } from "./button/copy-surface.js";
import { Placeholder } from "./button/placeholder.js";
import { Landing, type LandingProps } from "./landing.js";
import { UpdateToasts } from "./update-toasts.js";
import type { PaneSessions } from "./button/index.js";
import { createUpdateDraftCheckpointBarrier } from "./update-restart.js";

type FrameProjection = Readonly<{
  entries?: readonly TuiWorkspaceEntry[];
  configuration?: TuiWorkspaceConfiguration;
  queryClient?: QueryClient;
  requested?: number;
  picker?: SessionPickerProps;
  landing?: LandingProps & Pick<SessionPickerProps, "initialTheme">;
  recovery?: Readonly<{ message: string; retry: () => void; exit: () => void }>;
  serviceUpdated?: Readonly<{ message: string; exit: () => void }>;
}>;
type FrameStore = Readonly<{
  read: () => FrameProjection;
  subscribe: (listener: () => void) => () => void;
  update: (projection: FrameProjection) => void;
  restartUpdate: () => Promise<void>;
  bindUpdateRestart: (restart: () => Promise<void>) => () => void;
  registerCheckpoint: NonNullable<PaneSessions["registerDraftCheckpoint"]>;
  checkpointDrafts: (addresses: readonly string[]) => void;
}>;
const mountedFrames = new WeakMap<ReturnType<typeof createRoot>, FrameStore>();

function MountedFrame({ store }: Readonly<{ store: FrameStore }>) {
  return (
    <CopySurface>
      <MountedFrameContent store={store} />
      <UpdateToasts restart={store.restartUpdate} />
    </CopySurface>
  );
}

function MountedFrameContent({ store }: Readonly<{ store: FrameStore }>) {
  const projection = useSyncExternalStore(store.subscribe, store.read);
  const entries = projection.entries;
  const initialPresentation = useTerminalTheme(
    projection.picker?.initialTheme ??
      projection.landing?.initialTheme ??
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
  // Over a live workspace, recovery and a replaced service are Dialogs: the
  // one modal surface, drawn and dismissed like every other.
  const live = entries !== undefined && projection.queryClient !== undefined;
  const recovery = live ? projection.recovery : undefined;
  const updated = live ? projection.serviceUpdated : undefined;
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
    if (updated === undefined) return;
    const handle = dialog.show(() => <ServiceUpdated {...updated} />, {
      onDismiss: () => {
        if (store.read().serviceUpdated === updated) updated.exit();
      },
    });
    return () => {
      handle.dismiss();
    };
  }, [updated, dialog.show, store]);
  if (entries === undefined && projection.recovery !== undefined)
    return (
      <HostColorsContext.Provider value={initialPresentation.colors}>
        <ConnectionRecovery {...projection.recovery} />
      </HostColorsContext.Provider>
    );
  if (entries === undefined && projection.serviceUpdated !== undefined)
    return (
      <HostColorsContext.Provider value={initialPresentation.colors}>
        <ServiceUpdated {...projection.serviceUpdated} />
      </HostColorsContext.Provider>
    );
  if (entries === undefined && projection.landing !== undefined)
    return (
      <HostColorsContext.Provider value={initialPresentation.colors}>
        <Landing {...projection.landing} />
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
        registerDraftCheckpoint={store.registerCheckpoint}
        entries={entries}
        configuration={projection.configuration}
        requested={projection.requested ?? 0}
        dialog={dialog}
      />
    </QueryClientProvider>
  );
}

/** The one thing a running window says once a newer client replaced its service. */
function ServiceUpdated({
  message,
  exit,
}: Readonly<{ message: string; exit: () => void }>) {
  const colors = useHostColors();
  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={colors.warning}>{message}</text>
      <Picker
        title="Fungi was updated"
        colors={colors}
        choices={[{ name: "Exit this window" }]}
        onSelect={exit}
        onCancel={exit}
      />
    </box>
  );
}

export function renderTuiServiceUpdated(
  root: ReturnType<typeof createRoot>,
  message: string,
  exit: () => void,
) {
  const store = frameStore(root);
  store.update({ ...store.read(), serviceUpdated: { message, exit } });
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
  let mounted = false;
  let restartUpdate: (() => Promise<void>) | undefined;
  const checkpoints = createUpdateDraftCheckpointBarrier();
  const listeners = new Set<() => void>();
  const store: FrameStore = {
    registerCheckpoint: (session, checkpoint) =>
      checkpoints.register(session.address, checkpoint),
    checkpointDrafts: checkpoints.checkpoint,
    restartUpdate: async () => {
      if (restartUpdate === undefined)
        throw new Error(
          "Restart is unavailable in this window. Your current draft has not been changed.",
        );
      await restartUpdate();
    },
    bindUpdateRestart: (restart) => {
      if (restartUpdate !== undefined)
        throw new Error("This terminal already owns an update restart action");
      restartUpdate = restart;
      return () => {
        if (restartUpdate === restart) restartUpdate = undefined;
      };
    },
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next) => {
      current = next;
      if (!mounted) {
        mounted = true;
        root.render(<MountedFrame store={store} />);
      }
      for (const listener of listeners) listener();
    },
  };
  mountedFrames.set(root, store);
  return store;
}

export function renderTuiConnecting(root: ReturnType<typeof createRoot>): void {
  frameStore(root).update({});
}

/** The application owns restart; frame transitions never replace its binding. */
export function bindTuiUpdateRestart(
  root: ReturnType<typeof createRoot>,
  restart: () => Promise<void>,
): () => void {
  return frameStore(root).bindUpdateRestart(restart);
}

/** Synchronous public checkpoint barrier; never consumes or restores a draft. */
export function checkpointTuiUpdateDrafts(
  root: ReturnType<typeof createRoot>,
  addresses: readonly string[],
): void {
  frameStore(root).checkpointDrafts(addresses);
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

/** Bare fungi opens here until a conversation is chosen or started. */
export function renderTuiLanding(
  root: ReturnType<typeof createRoot>,
  props: LandingProps & Pick<SessionPickerProps, "initialTheme">,
): void {
  const store = frameStore(root);
  store.update({
    ...store.read(),
    landing: {
      ...props,
      choose: (choice) => {
        const next = { ...store.read() };
        delete next.landing;
        store.update(next);
        props.choose(choice);
      },
    },
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
