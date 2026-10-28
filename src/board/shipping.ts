import { reportFailure } from "../button/log-event.js";
import {
  maximumShippingSources,
  type ShippingSource,
  type ShippingSources,
} from "@fungi.computer/truffle/board-shipping";
import { startOfDay, type SourceRead } from "./model.js";

/** The most items one shipping source reports. */
const maximumShipItems = 50;

/** Private resource ceilings; none of them is product policy. */
export type ShippingTiming = Readonly<{
  /** One source that does not answer within this long reads as failed. */
  readMs: number;
}>;

const cut = (value: string, limit: number) =>
  value.length <= limit ? value : value.slice(0, limit - 1) + "…";

type Entry = { read: SourceRead | undefined; readAt: number; reading: boolean };

/**
 * Keeps each source's latest read. `tick` starts the reads that are due and
 * returns; each finished read calls `changed`. A source that throws or does
 * not answer is a `failed` read with its reason, never an empty one.
 */
export function createShippingReader(
  sources: ShippingSources,
  timing: ShippingTiming,
  changed: () => void,
) {
  const entries = new Map<string, Entry>();
  const lifetime = new AbortController();
  let failure: SourceRead | undefined;
  let ticking = false;

  async function readOne(source: ShippingSource, entry: Entry) {
    entry.reading = true;
    const sinceMs = startOfDay(Date.now());
    const timeout = AbortSignal.timeout(timing.readMs);
    const signal = AbortSignal.any([lifetime.signal, timeout]);
    const base = {
      sourceId: cut(source.id, 256),
      label: cut(source.label, 256),
    };
    try {
      const found = await Promise.race([
        source.read(sinceMs, signal),
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("did not answer in time"));
            },
            { once: true },
          );
        }),
      ]);
      const done = {
        ...base,
        state: found.state,
        readAt: Date.now(),
        items: found.items.slice(0, maximumShipItems),
      };
      entry.read =
        found.detail === undefined
          ? done
          : { ...done, detail: cut(found.detail, 200) };
    } catch (cause) {
      reportFailure("board-shipping-read", cause);
      entry.read = {
        ...base,
        state: "failed",
        readAt: Date.now(),
        detail: cut(
          timeout.aborted
            ? "did not answer in time"
            : cause instanceof Error
              ? cause.message
              : "could not be read",
          200,
        ),
        items: [],
      };
    } finally {
      entry.readAt = Date.now();
      entry.reading = false;
    }
    if (!lifetime.signal.aborted) changed();
  }

  return {
    /** Every source's latest read, in the order the sources are listed. */
    reads(): readonly SourceRead[] {
      if (failure !== undefined) return [failure];
      return [...entries.values()].flatMap((entry) =>
        entry.read === undefined ? [] : [entry.read],
      );
    },
    /** Start the reads that are due; never waits for them. */
    async tick(): Promise<void> {
      if (ticking) return;
      ticking = true;
      try {
        let listed: readonly ShippingSource[];
        try {
          listed = (await sources(lifetime.signal)).slice(
            0,
            maximumShippingSources,
          );
          failure = undefined;
        } catch (cause) {
          reportFailure("board-shipping-list", cause);
          failure = {
            sourceId: "shipping",
            label: "Shipping sources",
            state: "failed",
            readAt: Date.now(),
            detail: cut(
              cause instanceof Error ? cause.message : "could not be listed",
              200,
            ),
            items: [],
          };
          changed();
          return;
        }
        const ids = new Set(listed.map((source) => source.id));
        for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
        // Keep the listed order, whatever order the reads finish in.
        const ordered = new Map<string, Entry>();
        for (const source of listed) {
          const entry = entries.get(source.id) ?? {
            read: undefined,
            readAt: Number.NEGATIVE_INFINITY,
            reading: false,
          };
          ordered.set(source.id, entry);
          if (!entry.reading && Date.now() - entry.readAt >= source.refreshMs)
            void readOne(source, entry);
        }
        entries.clear();
        for (const [id, entry] of ordered) entries.set(id, entry);
      } finally {
        ticking = false;
      }
    },
    /** Stop every read and forget what they found. */
    close() {
      lifetime.abort();
      entries.clear();
    },
  };
}
