import { defineIdFamily } from "@fungi.computer/cairn/id";
import { terminalText } from "./terminal-text.js";

const toastIds = defineIdFamily({
  family: "tui-toast",
  version: 1,
  kinds: { toast: { prefix: "toast" } },
});

/** How long a toast stays when the caller names no duration. */
export const toastDurationMs = 4_000;
/** The most toasts waiting behind the visible one; only transient entries may be evicted. */
export const toastQueueLimit = 20;

/** The longest toast text, in characters. */
const toastTextLimit = 512;

function toastText(value: string): string {
  return Array.from(terminalText(value)).slice(0, toastTextLimit).join("");
}

export type ToastVariant = "info" | "success" | "warning" | "error";

/** A button on the toast, run once when the person activates it. */
export type ToastAction = Readonly<{
  label: string;
  run: () => void | Promise<void>;
}>;

export type ToastInput = Readonly<{
  variant: ToastVariant;
  message: string;
  title?: string | undefined;
  /** Milliseconds on screen while not hovered, or until the person dismisses it. */
  duration?: number | "until-dismissed" | undefined;
  action?: ToastAction | undefined;
  /** A producer-owned identity for unresolved attention; acknowledgement releases it. */
  key?: string | undefined;
}>;

/** One toast as the viewport draws it: text already made safe for a terminal. */
export type Toast = Readonly<{
  id: string;
  variant: ToastVariant;
  message: string;
  title?: string | undefined;
  duration: number | "until-dismissed";
  action?: ToastAction | undefined;
  /** The action owns this card until it settles; it cannot be activated twice. */
  actionPending?: boolean | undefined;
  key?: string | undefined;
}>;

export type ToastSnapshot = Readonly<{
  /** The toast on screen, when there is one. */
  current: Toast | undefined;
  /** How many more are queued behind it. */
  pending: number;
  /** Reports beyond the individual attention slots; never presented as retained detail. */
  attentionOverflow?: number | undefined;
}>;

export type ToastStore = Readonly<{
  snapshot: () => ToastSnapshot;
  subscribe: (listener: () => void) => () => void;
  show: (input: ToastInput) => void;
  /** Dismiss the toast on screen; the next queued one takes its place. */
  dismiss: () => void;
  /** Run once; advance on completion, or retain a warning on failure. */
  activate: () => void;
  /** Stop the clock while the pointer rests on the toast. */
  pause: () => void;
  resume: () => void;
  /** Stop the clock for good when the owner unmounts. */
  dispose: () => void;
}>;

/**
 * The one toast model: a visible toast on a timer, a bounded queue behind it,
 * and a hover pause that keeps the time the toast had left.
 */
export function createToastStore(): ToastStore {
  let current: Toast | undefined;
  let queue: readonly Toast[] = [];
  let snapshot: ToastSnapshot = { current: undefined, pending: 0 };
  let handle: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0;
  let remaining = 0;
  let paused = false;
  let disposed = false;
  // One bounded overflow record, not an unbounded second queue. Admitted
  // attention is never replaced; excess reports retain a count and latest text.
  let overflow: Readonly<{ reports: number; latest: string }> | undefined;
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot =
      overflow === undefined
        ? { current, pending: queue.length }
        : {
            current,
            pending: queue.length + 1,
            attentionOverflow: overflow.reports,
          };
    for (const listener of listeners) listener();
  };
  const stopClock = () => {
    clearTimeout(handle);
    handle = undefined;
  };
  const startClock = (milliseconds: number) => {
    stopClock();
    remaining = milliseconds;
    startedAt = Date.now();
    handle = setTimeout(dismiss, milliseconds);
  };
  const begin = (toast: Toast) => {
    current = toast;
    // A new card starts unhovered, so its clock always runs.
    if (toast.duration !== "until-dismissed") startClock(toast.duration);
  };
  function dismiss() {
    if (disposed || current?.actionPending) return;
    stopClock();
    current = undefined;
    paused = false;
    if (overflow !== undefined) {
      begin({
        id: toastIds.toast.generate(),
        title: "Attention capacity reached",
        variant: "warning",
        duration: "until-dismissed",
        message: toastText(
          `At least ${String(overflow.reports)} additional attention reports could not be listed individually. Latest: ${overflow.latest}`,
        ),
      });
      overflow = undefined;
    } else {
      const [next, ...rest] = queue;
      queue = rest;
      if (next !== undefined) begin(next);
    }
    publish();
  }
  return {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show: (input) => {
      if (disposed) return;
      const toast: Toast = {
        id: toastIds.toast.generate(),
        variant: input.variant,
        message: toastText(input.message),
        title: input.title === undefined ? undefined : toastText(input.title),
        duration: input.duration ?? toastDurationMs,
        action:
          input.action === undefined
            ? undefined
            : { ...input.action, label: toastText(input.action.label) },
        key: input.key === undefined ? undefined : toastText(input.key),
      };
      if (toast.duration === "until-dismissed" && toast.key !== undefined) {
        if (current?.key === toast.key) {
          if (!current.actionPending) {
            current = { ...toast, id: current.id };
            publish();
          }
          return;
        }
        const duplicate = queue.findIndex(
          (waiting) => waiting.key === toast.key,
        );
        const previous = queue[duplicate];
        if (previous !== undefined) {
          queue = queue.map((waiting, index) =>
            index === duplicate ? { ...toast, id: previous.id } : waiting,
          );
          publish();
          return;
        }
      }
      if (current === undefined) begin(toast);
      else {
        if (queue.length === toastQueueLimit) {
          const transient = queue.findIndex(
            (waiting) => waiting.duration !== "until-dismissed",
          );
          if (transient !== -1)
            queue = queue.filter((_, index) => index !== transient);
          else if (toast.duration !== "until-dismissed") return;
          else {
            overflow = {
              reports: Math.min(
                Number.MAX_SAFE_INTEGER,
                (overflow?.reports ?? 0) + 1,
              ),
              latest: toast.message,
            };
            publish();
            return;
          }
        }
        queue = [...queue, toast];
      }
      publish();
    },
    dismiss,
    activate: () => {
      if (disposed || current?.actionPending) return;
      const active = current;
      const action = active?.action;
      if (action === undefined) {
        dismiss();
        return;
      }
      if (active === undefined) return;
      stopClock();
      current = { ...active, actionPending: true };
      publish();
      const complete = () => {
        if (disposed || current?.id !== active.id) return;
        current = { ...current, actionPending: false };
        dismiss();
      };
      const fail = (cause: unknown) => {
        if (disposed || current?.id !== active.id) return;
        current = {
          ...current,
          variant: "warning",
          title: toastText(`${action.label} failed`),
          message: toastText(
            cause instanceof Error
              ? cause.message
              : "The action did not complete.",
          ),
          duration: "until-dismissed",
          action: undefined,
          actionPending: false,
        };
        publish();
      };
      try {
        const result = action.run();
        if (result === undefined) complete();
        else void Promise.resolve(result).then(complete, fail);
      } catch (cause) {
        fail(cause);
      }
    },
    pause: () => {
      if (disposed || current?.actionPending) return;
      if (current === undefined || paused) return;
      paused = true;
      if (handle === undefined) return;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
      stopClock();
    },
    resume: () => {
      if (disposed || current?.actionPending) return;
      if (current === undefined || !paused) return;
      paused = false;
      if (current.duration !== "until-dismissed") startClock(remaining);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopClock();
      listeners.clear();
      current = undefined;
      queue = [];
      overflow = undefined;
      snapshot = { current: undefined, pending: 0 };
    },
  };
}
