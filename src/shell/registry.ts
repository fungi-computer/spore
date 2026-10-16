import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { KeyEvent, PasteEvent } from "@opentui/core";
import type { ReactNode } from "react";
import type { AppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import {
  createWindowManager,
  type WindowHost,
} from "@fungi.computer/oyster/shell/window-manager";
import {
  arrangeTiles,
  createMaosaicoState,
  type Frame,
  type Minima,
  type TilingOptions,
} from "@fungi.computer/maosaico/headless";
import type {
  PaneDialogs,
  PaneInstance,
  PaneKit,
  PaneKindEntry,
  PaneNotice,
  PaneOpenOutcome,
  PaneSessions,
  PaneStatusItem,
  PaneTarget,
  PaneValue,
  PaneViewport,
} from "../button/index.js";
import { reportFailure } from "../button/index.js";
import { displayText } from "./display-text.js";
import { paneValue } from "./value.js";

const paneIds = defineIdFamily({
  family: "tui-pane",
  version: 1,
  kinds: { pane: { prefix: "tui_pane" } },
});

type PaneContainer = Readonly<{ paneId: string }>;
type PaneLaunch = Readonly<{
  windowId: string;
  instance: PaneInstance;
  identity: string;
  focus: boolean;
}>;
export type PaneProjection = Readonly<{
  paneId: string;
  title: string;
  frame: Frame;
  focused: boolean;
  zoomed: boolean;
  visible: boolean;
  node: ReactNode;
  state: "loading" | "ready" | "error";
  error: unknown;
  status: readonly PaneStatusItem[];
  presentation: import("../button/index.js").TuiPresentation;
}>;
export type PaneRegistryOptions = Readonly<{
  kinds: readonly PaneKindEntry[];
  exit: () => void;
  rendering: PaneKit["rendering"];
  commands: AppSurfaceCommandHost;
  viewport: PaneViewport;
  /** Native renderer minima, in cells; layout derives grouping from these. */
  minima: Minima;
  dialogs: PaneDialogs;
  sessions: PaneSessions;
  apps?: PaneKit["apps"];
  theme: PaneKit["theme"];
  notify: (notice: PaneNotice) => void;
}>;

type MountedPane = {
  kit: PaneKit;
  title: string;
  node: ReactNode;
  commandScope: string;
  viewport: ReturnType<typeof paneValue<PaneViewport>>;
  focused: ReturnType<typeof paneValue<boolean>>;
  keys: Set<(event: KeyEvent) => boolean>;
  pastes: Set<(event: PasteEvent) => void>;
  status: Map<symbol, PaneStatusItem>;
  theme: ReturnType<
    typeof paneValue<import("../button/index.js").TuiPresentation>
  >;
};

/** One lifecycle owner and one layout owner; neither knows a pane kind by name. */
export function createPaneRegistry(options: PaneRegistryOptions) {
  const kinds = new Map(options.kinds.map((entry) => [entry.kind, entry]));
  if (kinds.size !== options.kinds.length)
    throw new Error("Pane kinds must have distinct identities");
  const layout = createMaosaicoState();
  const mounts = new Map<string, MountedPane>();
  const instances = new Map<string, string>();
  const quitGuards = new Set<() => Promise<boolean>>();
  const projection = paneValue<readonly PaneProjection[]>([]);
  let bounds = options.viewport;
  let disposed = false;
  const retired = () => disposed;
  let disposal: Promise<void> | undefined;
  let axis: "x" | "y" = "x";
  let mountGeneration = 0;
  const lifetime = new AbortController();

  const refresh = () => {
    const tiling: TilingOptions = { axis, gap: 0 };
    if (layout.mainSize !== undefined) tiling.mainSize = layout.mainSize;
    const arrangement = arrangeTiles(
      layout.tiles,
      layout.minima,
      layout.order,
      bounds,
      tiling,
    );
    if (layout.zoomed !== null && layout.participating.has(layout.zoomed))
      arrangement.frames = new Map([
        [layout.zoomed, { x: 0, y: 0, ...bounds }],
      ]);
    const focusedId = layout.order.at(-1) ?? null;
    options.commands.focus(mounts.get(focusedId ?? "")?.commandScope ?? null);
    const next: PaneProjection[] = [];
    for (const window of windows.read().windows) {
      const pane = mounts.get(window.windowId);
      if (pane === undefined) continue;
      const arranged = arrangement.frames.get(window.windowId);
      const frame = arranged ?? { x: 0, y: 0, ...pane.viewport.value.read() };
      pane.focused.set(focusedId === window.windowId);
      const viewport = {
        width:
          Math.floor(frame.width) -
          (windows.read().windows.length > 1 &&
          layout.zoomed === null &&
          frame.x + frame.width < bounds.width
            ? 1
            : 0),
        height: Math.max(1, Math.floor(frame.height)),
      };
      if (
        viewport.width !== pane.viewport.value.read().width ||
        viewport.height !== pane.viewport.value.read().height
      )
        pane.viewport.set(viewport);
      next.push({
        paneId: window.windowId,
        title: pane.title,
        frame: {
          x: Math.floor(frame.x),
          y: Math.floor(frame.y),
          width: Math.floor(frame.width),
          height: Math.floor(frame.height),
        },
        visible: arranged !== undefined,
        focused: focusedId === window.windowId,
        zoomed: layout.zoomed === window.windowId,
        node: pane.node,
        state:
          window.status === "error"
            ? "error"
            : window.status === "loading"
              ? "loading"
              : "ready",
        error: window.error,
        status: [...pane.status.values()],
        presentation: pane.theme.value.read(),
      });
    }
    projection.set(next);
  };

  async function mount(
    launch: PaneLaunch,
    windowSignal: AbortSignal,
  ): Promise<WindowHost<PaneLaunch>> {
    const observation = new AbortController();
    const signal = AbortSignal.any([
      windowSignal,
      lifetime.signal,
      observation.signal,
    ]);
    const paneId = launch.windowId;
    const commandScope = `${paneId}:${String(++mountGeneration)}`;
    const commands = options.commands.mountPane(commandScope);
    const viewport = paneValue(bounds);
    const focused = paneValue(false);
    const keys = new Set<(event: KeyEvent) => boolean>();
    const pastes = new Set<(event: PasteEvent) => void>();
    const theme = paneValue(options.theme.read());
    const presentations = new Map<
      symbol,
      import("../button/index.js").TuiPresentation
    >();
    const publishTheme = () => {
      theme.set([...presentations.values()].at(-1) ?? options.theme.read());
      refresh();
    };
    const status = new Map<symbol, PaneStatusItem>();
    const statusItems = paneValue<readonly PaneStatusItem[]>([]);
    const displayStatus = (item: PaneStatusItem): PaneStatusItem => {
      const next = { ...item, text: displayText(item.text) };
      if (next.compact !== undefined) next.compact = displayText(next.compact);
      return next;
    };
    const publishStatus = () => {
      statusItems.set([...status.values()]);
      refresh();
    };
    const guards = new Set<() => Promise<boolean>>();
    const cleanups = new Set<() => void>();
    cleanups.add(
      options.theme.subscribe(() => {
        if (presentations.size === 0) publishTheme();
      }),
    );
    const dialogs = new Set<ReturnType<PaneDialogs["show"]>>();
    let live = true;
    function ownedValue<Value>(source: PaneValue<Value>): PaneValue<Value> {
      return {
        read: source.read,
        subscribe: (listener) => {
          if (!live) return () => undefined;
          const stop = source.subscribe(listener);
          cleanups.add(stop);
          return () => {
            cleanups.delete(stop);
            stop();
          };
        },
      };
    }
    const apps = options.apps;
    const kit: PaneKit = {
      paneId,
      setTitle: (title) => {
        if (!live) return;
        pane.title = displayText(title);
        if (pane.node !== null && mounts.get(paneId)?.kit === kit) refresh();
      },
      exit: options.exit,
      rendering: {
        afterFrame: (callback) => {
          if (!live) return () => undefined;
          const stop = options.rendering.afterFrame(() => {
            cleanups.delete(stop);
            if (live) callback();
          });
          cleanups.add(stop);
          return () => {
            cleanups.delete(stop);
            stop();
          };
        },
        requestFrame: () => {
          if (live) options.rendering.requestFrame();
        },
        isFocused: (renderable) =>
          live &&
          focused.value.read() &&
          options.rendering.isFocused(renderable),
      },
      viewport: ownedValue(viewport.value),
      input: {
        focused: ownedValue(focused.value),
        onKey: (handler) => {
          if (live) keys.add(handler);
          return () => {
            keys.delete(handler);
          };
        },
        onPaste: (handler) => {
          if (live) pastes.add(handler);
          return () => {
            pastes.delete(handler);
          };
        },
        requestFocus: () => {
          if (live) layout.focus(paneId);
        },
      },
      commands,
      dialogs: {
        dismiss: () => live && options.dialogs.dismiss(),
        open: ownedValue(options.dialogs.open),
        show: (render, configuration) => {
          if (!live) throw new Error("Pane has closed");
          const handle = options.dialogs.show(render, configuration);
          dialogs.add(handle);
          return handle;
        },
      },
      status: {
        items: ownedValue(statusItems.value),
        contribute: (item) => {
          if (!live) throw new Error("Pane has closed");
          const id = Symbol();
          status.set(id, displayStatus(item));
          publishStatus();
          return {
            update: (next) => {
              if (live && status.has(id)) {
                status.set(id, displayStatus(next));
                publishStatus();
              }
            },
            dispose: () => {
              if (status.delete(id)) publishStatus();
            },
          };
        },
      },
      replace: (target) =>
        live
          ? replace(paneId, target)
          : Promise.resolve({ kind: "refused", reason: "Pane has closed" }),
      open: (target) =>
        live
          ? open(target)
          : Promise.resolve({ kind: "refused", reason: "Pane has closed" }),
      notify: (notice) => {
        if (live)
          options.notify({ ...notice, message: displayText(notice.message) });
      },
      apps:
        apps === undefined
          ? undefined
          : {
              signedIn: (callerSignal) =>
                apps.signedIn(AbortSignal.any([signal, callerSignal])),
              read: (callerSignal) =>
                apps.read(AbortSignal.any([signal, callerSignal])),
              requestGill: (surfaceId, request, callerSignal) =>
                apps.requestGill(
                  surfaceId,
                  request,
                  AbortSignal.any([signal, callerSignal]),
                ),
              openUi: (surfaceId, callerSignal) =>
                apps.openUi(surfaceId, AbortSignal.any([signal, callerSignal])),
            },
      sessions: {
        ...options.sessions,
        acquire: (target, callerSignal) =>
          options.sessions.acquire(
            target,
            AbortSignal.any([signal, callerSignal]),
          ),
      },
      theme: ownedValue(theme.value),
      presentTheme: (value) => {
        if (!live) throw new Error("Pane has closed");
        const id = Symbol();
        presentations.set(id, value);
        publishTheme();
        return {
          update: (next) => {
            if (live && presentations.has(id)) {
              presentations.set(id, next);
              publishTheme();
            }
          },
          dispose: () => {
            if (presentations.delete(id) && live) publishTheme();
          },
        };
      },
      signal,
      onDispose: (cleanup) => {
        if (live) cleanups.add(cleanup);
        else cleanup();
      },
      guardClose: (guard) => {
        if (live) guards.add(guard);
        return () => {
          guards.delete(guard);
        };
      },
      guardQuit: (guard) => {
        if (live) quitGuards.add(guard);
        const stop = () => {
          quitGuards.delete(guard);
        };
        cleanups.add(stop);
        return stop;
      },
    };
    const release = () => {
      if (!live) return;
      live = false;
      observation.abort();
      const failures: unknown[] = [];
      const cleanup = (operation: () => void) => {
        try {
          operation();
        } catch (cause) {
          failures.push(cause);
        }
      };
      for (const dialog of dialogs) cleanup(dialog.dismiss);
      for (const operation of cleanups) cleanup(operation);
      cleanup(commands.dispose);
      pane.node = null;
      keys.clear();
      pastes.clear();
      status.clear();
      statusItems.clear();
      presentations.clear();
      theme.clear();
      guards.clear();
      cleanups.clear();
      viewport.clear();
      focused.clear();
      if (mounts.get(paneId)?.kit === kit) {
        mounts.delete(paneId);
        if (instances.get(launch.identity) === paneId)
          instances.delete(launch.identity);
        layout.unregister(paneId);
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Pane cleanup failed");
    };
    const pane: MountedPane = {
      kit,
      title: displayText(launch.instance.title),
      node: null,
      commandScope,
      viewport,
      focused,
      keys,
      pastes,
      status,
      theme,
    };
    const previous = mounts.get(paneId);
    try {
      // A replacement is prepared offscreen; the working pane retains its
      // commands and focus until acquisition has completed successfully.
      if (previous === undefined) {
        mounts.set(paneId, pane);
        layout.register(paneId, { x: 0, y: 0, ...bounds }, options.minima);
        if (launch.focus) layout.focus(paneId);
      }
      pane.node = await launch.instance.render(kit);
      if (!signal.aborted) {
        mounts.set(paneId, pane);
        if (previous !== undefined) layout.focus(paneId);
        refresh();
      }
    } catch (cause) {
      try {
        release();
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          "Pane mount and cleanup failed",
          { cause: cleanupCause },
        );
      }
      throw cause;
    }
    let replacement: WindowHost<PaneLaunch> | undefined;
    return {
      reconfigure: async (next, transitionSignal) => {
        if (replacement !== undefined) {
          if ((await replacement.requestClose?.()) === false)
            throw new Error("Pane close was declined");
        } else {
          for (const guard of guards)
            if (!(await guard())) throw new Error("Pane close was declined");
        }
        const nextHost = await mount(
          next,
          transitionSignal === undefined
            ? windowSignal
            : AbortSignal.any([windowSignal, transitionSignal]),
        );
        const previousHost = replacement;
        replacement = nextHost;
        if (previousHost !== undefined) await previousHost.dispose();
        else release();
      },
      setVisibility: (visibility: "hidden" | "visible") => {
        if (replacement !== undefined)
          return replacement.setVisibility(visibility);
        layout.setParticipation(paneId, visibility === "visible");
      },
      requestClose: async () => {
        if (replacement !== undefined)
          return (await replacement.requestClose?.()) ?? true;
        for (const guard of guards) if (!(await guard())) return false;
        return true;
      },
      dispose: () => {
        if (replacement === undefined) release();
        else return replacement.dispose();
      },
    };
  }

  const windows = createWindowManager<PaneLaunch, PaneContainer>({
    createContainer: ({ windowId }) => ({ paneId: windowId }),
    mount: (_container, launch, signal) => mount(launch, signal),
    onFailure: ({ cause }) => {
      reportFailure("pane-lifetime", cause);
    },
  });
  const stopWindows = windows.subscribe(refresh);
  const stopLayout = layout.subscribe(refresh);

  async function open(
    target: PaneTarget,
    focus = true,
  ): Promise<PaneOpenOutcome> {
    if (disposed) return { kind: "refused", reason: "Workspace has closed" };
    const instance = kinds.get(target.kind)?.instantiate(target);
    if (instance === undefined)
      return { kind: "refused", reason: "Pane target is not supported" };
    const identity = JSON.stringify([target.kind, instance.key]);
    const existing = instances.get(identity);
    if (existing !== undefined) {
      if (focus) layout.focus(existing);
      return { kind: "focused", paneId: existing };
    }
    const paneId = paneIds.pane.generate();
    instances.set(identity, paneId);
    await windows.open({ windowId: paneId, instance, identity, focus });
    const window = windows
      .read()
      .windows.find((candidate) => candidate.windowId === paneId);
    if (retired() || window === undefined)
      return { kind: "refused", reason: "Workspace closed while opening pane" };
    if (window.status === "error") {
      instances.delete(identity);
      await windows.close(paneId);
      throw new Error("Pane mount failed", { cause: window.error });
    }
    return { kind: "opened", paneId };
  }

  async function replace(
    paneId: string,
    target: PaneTarget,
  ): Promise<PaneOpenOutcome> {
    const previous = windows
      .read()
      .windows.find((item) => item.windowId === paneId);
    if (disposed || previous === undefined)
      return { kind: "refused", reason: "Pane has closed" };
    const instance = kinds.get(target.kind)?.instantiate(target);
    if (instance === undefined)
      return { kind: "refused", reason: "Pane target is not supported" };
    const identity = JSON.stringify([target.kind, instance.key]);
    const existing = instances.get(identity);
    if (existing !== undefined && existing !== paneId)
      return {
        kind: "refused",
        reason: "That conversation is already open in another pane",
      };
    if (identity === previous.launch.identity)
      return { kind: "focused", paneId };
    try {
      await windows.reconfigure(paneId, {
        windowId: paneId,
        instance,
        identity,
        focus: true,
      });
    } catch (cause) {
      throw new Error("Pane mount failed", { cause });
    }
    const committed = windows
      .read()
      .windows.find((item) => item.windowId === paneId);
    if (committed?.launch.identity !== identity)
      return {
        kind: "refused",
        reason: "Pane closed while preparing replacement",
      };
    instances.delete(previous.launch.identity);
    instances.set(identity, paneId);
    refresh();
    return { kind: "opened", paneId };
  }

  const focusedMount = () => mounts.get(layout.order.at(-1) ?? "");
  return {
    /** The shell's non-modal notice, shared with every pane's kit. */
    notify: options.notify,
    /** **Open pane** rows, in registration order, as each kind declares them. */
    launchers: options.kinds.flatMap((entry) =>
      entry.launcher === undefined ? [] : [entry.launcher],
    ),
    open,
    canQuit: async () => {
      for (const guard of quitGuards) if (!(await guard())) return false;
      return true;
    },
    close: windows.close,
    replace,
    focus: layout.focus,
    swap: layout.swap,
    zoom: layout.zoom,
    toggleZoom: (paneId: string) => {
      layout.zoom(layout.zoomed === paneId ? null : paneId);
    },
    resizeBy: (delta: number) => {
      const tiling: TilingOptions = { axis, gap: 0 };
      if (layout.mainSize !== undefined) tiling.mainSize = layout.mainSize;
      const arrangement = arrangeTiles(
        layout.tiles,
        layout.minima,
        layout.order,
        bounds,
        tiling,
      );
      const divider = arrangement.divider;
      if (divider !== null)
        layout.resizeMain(
          Math.max(
            divider.min,
            Math.min(divider.max, divider.position + delta),
          ),
        );
    },
    resize: (size: number) => {
      layout.resizeMain(Math.max(0, size));
    },
    split: (nextAxis: "x" | "y") => {
      axis = nextAxis;
      refresh();
    },
    viewport: (next: PaneViewport) => {
      bounds = next;
      refresh();
    },
    read: projection.value.read,
    subscribe: projection.value.subscribe,
    /** Overlay handlers run first in the native shell adapter. */
    key: (event: KeyEvent) => {
      if (options.dialogs.open.read() || event.defaultPrevented) return false;
      for (const handler of focusedMount()?.keys ?? [])
        if (handler(event)) {
          event.preventDefault();
          return true;
        }
      return false;
    },
    paste: (event: PasteEvent) => {
      if (options.dialogs.open.read() || event.defaultPrevented) return;
      for (const handler of focusedMount()?.pastes ?? []) handler(event);
    },
    /** A Team retirement uses the same cleanup path as shell shutdown. */
    dispose: () => {
      if (disposal !== undefined) return disposal;
      disposed = true;
      lifetime.abort();
      disposal = windows.dispose().finally(() => {
        stopWindows();
        stopLayout();
        layout.destroy();
        projection.clear();
      });
      return disposal;
    },
  };
}
