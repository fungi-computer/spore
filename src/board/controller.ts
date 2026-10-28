import { reportFailure } from "../button/log-event.js";
import { readBoardAgents } from "@fungi.computer/truffle/board-agents";
import type { ShippingSources } from "@fungi.computer/truffle/board-shipping";
import {
  failedRows,
  project,
  readRows,
  type BoardProjection,
  type BoardRows,
  type Expanded,
} from "./model.js";
import { createShippingReader, type ShippingTiming } from "./shipping.js";

/** Private resource ceilings; none of them is product policy. */
export type BoardTiming = Readonly<{
  /** Agents and lanes are read again this often. */
  pollMs: number;
}>;

/** The board as a program holds it: live reads, and what the person asked to see. */
export type BoardController = Readonly<{
  /** The board now, or undefined until the first read finishes. */
  read: () => BoardProjection | undefined;
  /** Hear of every change; returns the way to stop hearing. */
  subscribe: (listener: () => void) => () => void;
  /** Flip whether every row of one part is listed. */
  toggle: (part: keyof Expanded) => void;
  /** Read the Agents again now. */
  refresh: () => void;
  /** Stop reading. */
  close: () => void;
}>;

/**
 * Reads this folder's Agents from their stores, and the shipping sources, for
 * as long as it lives: nothing starts an Agent, and nothing is read once the
 * program is closed.
 */
export function createBoardController(
  options: Readonly<{
    root: string;
    shipping: ShippingSources;
    timing?: BoardTiming;
    shippingTiming?: ShippingTiming;
    now?: () => number;
  }>,
): BoardController {
  const timing = options.timing ?? { pollMs: 5_000 };
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let rows: BoardRows | undefined;
  let expanded: Expanded = { lanes: false, shipping: false };
  let reading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Closing can happen at any await, which flow analysis cannot see.
  const stopped = () => lifetime.signal.aborted;
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const shipping = createShippingReader(
    options.shipping,
    options.shippingTiming ?? { readMs: 20_000 },
    changed,
  );
  async function refresh() {
    if (reading || stopped()) return;
    reading = true;
    clearTimeout(timer);
    void shipping.tick();
    try {
      rows = readRows(await readBoardAgents(options.root), now());
    } catch (cause) {
      reportFailure("board-agents-read", cause);
      rows = failedRows(rows, cause, now());
    } finally {
      reading = false;
    }
    changed();
    if (!stopped())
      timer = setTimeout(() => {
        void refresh();
      }, timing.pollMs);
  }
  void refresh();
  return {
    read: () =>
      rows === undefined
        ? undefined
        : project(rows, shipping.reads(), expanded),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toggle: (part) => {
      expanded = { ...expanded, [part]: !expanded[part] };
      changed();
    },
    refresh: () => {
      void refresh();
    },
    close: () => {
      lifetime.abort();
      clearTimeout(timer);
      shipping.close();
      listeners.clear();
    },
  };
}
