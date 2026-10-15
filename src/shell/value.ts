import type { PaneValue } from "../button/index.js";

/** Stable snapshots for React and native host subscribers. */
export function paneValue<Value>(initial: Value) {
  let current = initial;
  const listeners = new Set<() => void>();
  const value: PaneValue<Value> = {
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    value,
    set: (next: Value) => {
      if (Object.is(current, next)) return;
      current = next;
      for (const listener of listeners) listener();
    },
    clear: () => {
      listeners.clear();
    },
  };
}
