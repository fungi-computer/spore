import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { KeyEvent, PasteEvent, Renderable } from "@opentui/core";
import type { ParakeetCommandRuntime } from "@fungi.computer/parakeet/headless";
import type { PaneKit } from "./index.js";

const context = createContext<PaneKit | undefined>(undefined);

export function PaneProvider({
  kit,
  children,
}: Readonly<{ kit: PaneKit; children?: ReactNode }>) {
  return <context.Provider value={kit}>{children}</context.Provider>;
}

export function usePaneKit(): PaneKit {
  const kit = useContext(context);
  if (kit === undefined) throw new Error("A pane must be mounted by its shell");
  return kit;
}

export function usePaneViewport() {
  const { viewport } = usePaneKit();
  return useSyncExternalStore(viewport.subscribe, viewport.read);
}

export function usePaneFocused() {
  const { input } = usePaneKit();
  return useSyncExternalStore(input.focused.subscribe, input.focused.read);
}

export function usePaneKeyboard(handler: (event: KeyEvent) => boolean) {
  const { input } = usePaneKit();
  const current = useRef(handler);
  current.current = handler;
  useEffect(() => input.onKey((event) => current.current(event)), [input]);
}

/**
 * KeyScope's native-focus half: a renderable holds the renderer's focus
 * exactly while its pane is focused, no Dialog is open and `enabled` holds.
 * It focuses and blurs, and a pane key re-asserts focus a click moved away.
 * Returns whether the renderable is the active input.
 */
export function useNativeFocus<R extends Renderable>(
  ref: Readonly<{ current: R | null }>,
  options: Readonly<{
    enabled: boolean;
    /** Replaces `focus()` when activation must hand pending input over. */
    deliver?: ((renderable: R) => void) | undefined;
  }>,
): boolean {
  const kit = usePaneKit();
  const focused = usePaneFocused();
  const modal = useSyncExternalStore(
    kit.dialogs.open.subscribe,
    kit.dialogs.open.read,
  );
  const active = focused && !modal && options.enabled;
  const deliver = options.deliver;
  useEffect(() => {
    const renderable = ref.current;
    if (renderable === null) return;
    if (!active) renderable.blur();
    else if (deliver === undefined) renderable.focus();
    else deliver(renderable);
  }, [ref, active, deliver]);
  usePaneKeyboard(() => {
    const renderable = ref.current;
    if (active && renderable !== null && !kit.rendering.isFocused(renderable))
      renderable.focus();
    return false;
  });
  return active;
}

export function usePanePaste(handler: (event: PasteEvent) => void) {
  const { input } = usePaneKit();
  const current = useRef(handler);
  current.current = handler;
  useEffect(
    () =>
      input.onPaste((event) => {
        current.current(event);
      }),
    [input],
  );
}

/** Adapt Parakeet's public contribution envelope to the pane-owned scope. */
export function paneCommandRuntime(kit: PaneKit): ParakeetCommandRuntime {
  const ids = new Map<string, string>();
  return {
    ...kit.commands,
    contribute: (contribution) => {
      const local = (id: string) =>
        `${encodeURIComponent(contribution.namespace)}/${id}`;
      const mapped = (commands: typeof contribution.commands) =>
        commands.map((command) => ({ ...command, id: local(command.id) }));
      let commands = contribution.commands;
      const lease = kit.commands.contribute(mapped(commands));
      const remember = () => {
        for (const command of commands)
          ids.set(
            `${contribution.namespace}:${command.id}`,
            kit.commands.commandId(local(command.id)),
          );
      };
      const forget = () => {
        for (const command of commands)
          ids.delete(`${contribution.namespace}:${command.id}`);
      };
      remember();
      return {
        update: (next) => {
          lease.update(mapped(next));
          forget();
          commands = next;
          remember();
        },
        dispose: () => {
          forget();
          lease.dispose();
        },
      };
    },
    execute: (commandId, input) =>
      kit.commands.execute(ids.get(commandId) ?? commandId, input),
  };
}

/** A renderer's local preview is shared with its shell only while it is mounted. */
export function usePanePresentation(
  presentation: import("./presentation.js").TuiPresentation,
): void {
  const kit = usePaneKit();
  useLayoutEffect(() => {
    const lease = kit.presentTheme(presentation);
    return lease.dispose;
  }, [kit, presentation.colors, presentation.surface, presentation.syntax]);
}
