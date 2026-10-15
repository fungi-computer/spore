import { stringWidth } from "bun";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { usePaneKit } from "./runtime.js";
import type { PaneStatusItem } from "./index.js";

const toneColors = {
  info: "foreground",
  success: "success",
  warning: "warning",
  error: "error",
  muted: "foreground",
} as const;

/** Publish status through the pane's lease, including replacement and teardown. */
export function usePaneStatus(items: readonly PaneStatusItem[]): void {
  const { status } = usePaneKit();
  useLayoutEffect(() => {
    const leases = items.map((item) => status.contribute(item));
    return () => {
      for (const lease of leases) lease.dispose();
    };
  }, [status, items]);
}

/** The shared one-row renderer; a pane supplies data, never a shell component. */
export function PaneStatusLine({ inset = 1 }: Readonly<{ inset?: number }>) {
  const kit = usePaneKit();
  const items = useSyncExternalStore(
    kit.status.items.subscribe,
    kit.status.items.read,
  );
  const { colors } = useSyncExternalStore(kit.theme.subscribe, kit.theme.read);
  const ordered = [...items].sort((a, b) => a.order - b.order);
  const left = ordered.filter(
    (item) => item.slot === "state" || item.slot === "chips",
  );
  const right = ordered.filter((item) => item.slot === "model");
  const text = (item: PaneStatusItem, index: number, dim: boolean) =>
    item.text.length === 0 ? null : (
      <text
        key={`${item.slot}:${String(index)}`}
        fg={colors[toneColors[item.tone]]}
        attributes={dim ? 2 : 0}
        width={stringWidth(item.text)}
        flexShrink={dim ? 0 : 1}
        wrapMode="none"
      >
        {item.text}
      </text>
    );
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      columnGap={1}
      height={1}
      paddingX={inset}
    >
      <box flexDirection="row" columnGap={1} flexShrink={1} minWidth={0}>
        {left.map((item, index) => text(item, index, false))}
      </box>
      {right.map((item, index) => text(item, index, true))}
    </box>
  );
}
