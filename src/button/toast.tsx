import { RGBA, TextAttributes, type KeyEvent } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createToastStore,
  type Toast,
  type ToastStore,
  type ToastVariant,
} from "./toast-store.js";

export type { ToastInput } from "./toast-store.js";
export { toastDurationMs } from "./toast-store.js";

/** What a caller needs: show a toast, or dismiss the one on screen. */
export type ToastApi = Pick<ToastStore, "show" | "dismiss">;

const ToastContext = createContext<ToastStore | undefined>(undefined);

/** Toasts follow the terminal's own palette, like the surface they float over. */
const variantColors = {
  info: RGBA.fromIndex(4),
  success: RGBA.fromIndex(2),
  warning: RGBA.fromIndex(3),
  error: RGBA.fromIndex(1),
} satisfies Record<ToastVariant, RGBA>;
const toastBackground = RGBA.defaultBackground();
const toastMaxWidth = 60;

/** Show or dismiss a toast from any view under a ToastProvider. */
export function useToast(): ToastApi {
  const store = useContext(ToastContext);
  if (store === undefined)
    throw new Error("Toasts need a ToastProvider above this view");
  return useMemo(() => ({ show: store.show, dismiss: store.dismiss }), [store]);
}

/**
 * The one owner of toasts for a tree. The outermost provider wins: a nested one
 * only passes its children through, so a view can be mounted alone or inside
 * the application root. It must sit in a full-size positioned box.
 */
export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const parent = useContext(ToastContext);
  return parent === undefined ? <ToastOwner>{children}</ToastOwner> : children;
}

function ToastOwner({ children }: Readonly<{ children: ReactNode }>) {
  const renderer = useRenderer();
  const [store] = useState(createToastStore);
  useEffect(
    () => () => {
      store.dispose();
    },
    [store],
  );
  useEffect(() => {
    // Esc dismisses the top toast and goes no further, so it never also
    // cancels a running turn or closes a dialog.
    const escape = (event: KeyEvent) => {
      if (event.name !== "escape" || store.snapshot().current === undefined)
        return;
      event.preventDefault();
      event.stopPropagation();
      store.dismiss();
    };
    renderer.keyInput.prependListener("keypress", escape);
    return () => {
      renderer.keyInput.off("keypress", escape);
    };
  }, [renderer, store]);
  return (
    <ToastContext.Provider value={store}>
      {children}
      <ToastViewport store={store} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ store }: Readonly<{ store: ToastStore }>) {
  const { current, pending, attentionOverflow } = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
  );
  return current === undefined ? null : (
    <ToastCard
      key={current.id}
      toast={current}
      pending={pending}
      attentionOverflow={attentionOverflow}
      store={store}
    />
  );
}

function ToastCard({
  toast,
  pending,
  attentionOverflow,
  store,
}: Readonly<{
  toast: Toast;
  pending: number;
  attentionOverflow: number | undefined;
  store: ToastStore;
}>) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const [hovered, setHovered] = useState(false);
  const hover = (value: boolean) => {
    setHovered(value);
    if (value) store.pause();
    else store.resume();
  };
  const affordance = (
    <box flexDirection="row" flexShrink={0}>
      {toast.action === undefined ? null : (
        <text marginLeft={2} wrapMode="none">
          {toast.actionPending ? "Working…" : `› ${toast.action.label}`}
        </text>
      )}
      {toast.actionPending ? null : (
        <text
          flexShrink={0}
          marginLeft={2}
          wrapMode="none"
          attributes={hovered ? TextAttributes.BOLD : TextAttributes.DIM}
          onMouseUp={(event) => {
            event.stopPropagation();
            store.dismiss();
          }}
        >
          x
        </text>
      )}
    </box>
  );
  return (
    <box
      position="absolute"
      top={1}
      right={2}
      zIndex={300}
      maxWidth={Math.max(20, Math.min(toastMaxWidth, width - 6))}
      border={["left"]}
      borderColor={variantColors[toast.variant]}
      backgroundColor={toastBackground}
      paddingLeft={1}
      paddingRight={1}
      onMouseOver={() => {
        hover(true);
      }}
      onMouseOut={() => {
        hover(false);
      }}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return;
        store.activate();
      }}
    >
      {toast.title === undefined ? (
        <box flexDirection="row" width="100%">
          <text flexGrow={1} wrapMode="word">
            {toast.message}
          </text>
          {affordance}
        </box>
      ) : (
        <>
          <box flexDirection="row" width="100%">
            <text attributes={TextAttributes.BOLD}>{toast.title}</text>
            <box flexGrow={1} />
            {affordance}
          </box>
          <text width="100%" flexShrink={0} wrapMode="word">
            {toast.message}
          </text>
        </>
      )}
      {pending === 0 ? null : (
        <text attributes={TextAttributes.DIM}>+{pending} more</text>
      )}
      {attentionOverflow === undefined ? null : (
        <text fg={variantColors.warning}>
          {attentionOverflow} additional attention reports not listed
          individually
        </text>
      )}
    </box>
  );
}
