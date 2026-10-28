import type {
  ShipItem,
  ShipKind,
} from "@fungi.computer/truffle/board-shipping";
import type {
  BoardProjection,
  Lane,
  LaneState,
  NeedsYou,
  SourceRead,
} from "./model.js";

/** How a row is toned; only NEEDS YOU is `attention`. */
export type BoardTone = "attention" | "error" | "running" | "settled" | "muted";

/** The conversation a row opens. */
export type BoardOpen = Readonly<{
  /** The Agent that owns the conversation. */
  agentId: string;
  /** The conversation to show. */
  sessionId: string;
}>;

/** One board row: a title, what the asker said about it, and what Enter does. */
export type BoardRow = Readonly<{
  /** Stable across reads, for keeping the selection on the same row. */
  id: string;
  /** How the row is colored. */
  tone: BoardTone;
  /** The row's left-aligned text. */
  title: string;
  /** Right-aligned context; only the age at narrow widths. */
  meta: string;
  /** What Enter does; absent when the row has no conversation. */
  open?: BoardOpen;
}>;

/** A titled group of rows. */
export type BoardSection = Readonly<{
  /** Which part of the board this is. */
  id: "needs" | "lanes" | "shipped";
  /** The heading, with its count. */
  title: string;
  /** The rows under the heading. */
  rows: readonly BoardRow[];
  /** Muted lines under the rows: what the count is made of and what is not listed. */
  notes: readonly string[];
  /** Sources that could not be read, each one error-toned line apart from the list. */
  problems: readonly string[];
}>;

/** What every surface draws; TUI and web only lay it out. */
export type BoardView = Readonly<{
  /** Whether the width is narrow enough that context drops and only ages stay. */
  compact: boolean;
  /** The whole board when nothing needs a look; null otherwise. */
  calm: string | null;
  /** Why the Agents could not be read, when the last read failed. */
  failure: string | null;
  /** When the host last read, as a clock time. */
  readAt: string;
  /** The listed groups, NEEDS YOU first. */
  sections: readonly BoardSection[];
  /** The count line for lanes not listed, or null. */
  summary: string | null;
  /** Rows Enter can open, in reading order. */
  selectable: readonly BoardRow[];
}>;

/** Widths at or below this drop context and keep only the age. */
const compactWidth = 60;

const clock = (at: number) => {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
};

/** A short age: now, 12m, 3h, 2d. */
function age(since: number | null, now: number): string {
  if (since === null) return "";
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${String(hours)}h`
    : `${String(Math.floor(hours / 24))}d`;
}

const laneTone = {
  stuck: "error",
  failed: "error",
  stopped: "error",
  unavailable: "muted",
  waiting_on_you: "attention",
  waiting_on_agent: "muted",
  working: "running",
  idle: "settled",
} as const satisfies Record<LaneState, BoardTone>;

const laneLabel = {
  stuck: "stuck",
  failed: "failed",
  stopped: "stopped mid-run",
  unavailable: "unavailable",
  waiting_on_you: "waiting on you",
  waiting_on_agent: "waiting on an agent",
  working: "working",
  idle: "idle",
} as const satisfies Record<LaneState, string>;

function needsRow(item: NeedsYou, now: number, compact: boolean): BoardRow {
  const waited = age(item.since, now);
  return {
    id: item.id,
    tone: "attention",
    title: `${item.agentName} · ${item.summary}`,
    meta: compact
      ? waited
      : [item.kind, item.sessionTitle, waited]
          .filter((part) => part !== "")
          .join(" · "),
    open: { agentId: item.agentId, sessionId: item.sessionId },
  };
}

function laneRow(lane: Lane, now: number): BoardRow {
  const label =
    lane.detail === undefined
      ? laneLabel[lane.state]
      : `${laneLabel[lane.state]}: ${lane.detail}`;
  const row = {
    id: `lane/${lane.agentId}`,
    tone: laneTone[lane.state],
    title: `${lane.name} · ${label}`,
    meta:
      lane.state === "failed" && lane.since !== null
        ? clock(lane.since)
        : age(lane.since, now),
  };
  return lane.sessionId === null
    ? row
    : { ...row, open: { agentId: lane.agentId, sessionId: lane.sessionId } };
}

/** The count line for what the lane section does not list. */
function laneSummary(view: BoardProjection): string | null {
  const { counts, shown, more } = view.lanes;
  const listed = (state: LaneState) =>
    shown.filter((lane) => lane.state === state).length;
  const parts = [
    ...(["working", "waiting_on_agent"] as const)
      .map((state) => [state, counts[state] - listed(state)] as const)
      .filter(([, remaining]) => remaining > 0)
      .map(([state, remaining]) => `${String(remaining)} ${laneLabel[state]}`),
    ...(more > 0 ? [`${String(more)} more not listed`] : []),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}

const shipTone = {
  landed: "settled",
  released: "settled",
  queued: "muted",
  gating: "running",
  dropped: "error",
} as const satisfies Record<ShipKind, BoardTone>;

/** The kinds a count line names, in the order a person asks about them. */
const shipKinds = [
  "landed",
  "released",
  "gating",
  "queued",
  "dropped",
] as const satisfies readonly ShipKind[];

/** Items from every source that could be read, newest first. */
function shippedItems(shipping: readonly SourceRead[]): readonly ShipItem[] {
  return shipping
    .flatMap((source) => source.items)
    .sort(
      (left, right) => right.at - left.at || left.id.localeCompare(right.id),
    );
}

/** `14 landed · 1 released`, naming only what happened. */
function shipCounts(items: readonly ShipItem[]): string {
  return shipKinds
    .map(
      (kind) =>
        [kind, items.filter((item) => item.kind === kind).length] as const,
    )
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${String(count)} ${kind}`)
    .join(" · ");
}

/** What happened to a source that is not ok, after its reason. */
function sourceState(source: SourceRead): string | null {
  switch (source.state) {
    case "ok":
      return null;
    case "failed":
      return `could not read ${source.label} (${clock(source.readAt)})`;
    case "held":
      return `${source.label} held`;
    case "stopped":
      return `${source.label} not running`;
  }
}

/**
 * A source that could not be read is one line, never a silent zero. The
 * reason leads, so a narrow board that cuts the line still says why.
 */
function sourceProblem(source: SourceRead): string | null {
  const state = sourceState(source);
  if (state === null) return null;
  return source.detail === undefined ? state : `${source.detail} · ${state}`;
}

/** The newest few items shown while the section is collapsed. */
const collapsedItems = 3;

function shippedSection(view: BoardProjection): BoardSection | undefined {
  if (view.shipping.length === 0) return undefined;
  const items = shippedItems(view.shipping);
  const problems = view.shipping.flatMap((source) => {
    const line = sourceProblem(source);
    return line === null ? [] : [line];
  });
  if (items.length === 0 && problems.length === 0 && !view.expanded.shipping)
    return undefined;
  const listed = view.expanded.shipping
    ? items
    : items.slice(0, collapsedItems);
  const hidden = items.length - listed.length;
  const counts = shipCounts(items);
  const more = [
    ...(hidden > 0 ? [`+ ${String(hidden)} more · s shows`] : []),
    ...(view.expanded.shipping && items.length > collapsedItems
      ? ["s shows fewer"]
      : []),
  ];
  const notes = [counts, ...more].filter((part) => part !== "").join(" · ");
  return {
    id: "shipped",
    // The heading carries one count, like the other sections; the split
    // by kind is the first note.
    title:
      items.length === 0
        ? "SHIPPED TODAY"
        : `SHIPPED TODAY ${String(items.length)}`,
    rows: listed.map((item) => ({
      id: `ship/${item.id}`,
      tone: shipTone[item.kind],
      title: item.title,
      meta: clock(item.at),
    })),
    notes: notes === "" ? [] : [notes],
    problems,
  };
}

/**
 * The nothing-to-do line: what is running and what shipped, in a breath. A
 * compact board drops the closing "today" so the line keeps to one row.
 */
function calmLine(view: BoardProjection, compact: boolean): string {
  const { counts } = view.lanes;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const shipped = shipCounts(shippedItems(view.shipping));
  const today = shipped === "" ? [] : [compact ? shipped : `${shipped} today`];
  if (total === 0)
    return ["Nothing needs you. No Agents yet.", ...today].join("  ");
  const parts = [
    ...(counts.working > 0 ? [`${String(counts.working)} working`] : []),
    ...(counts.waiting_on_agent > 0
      ? [`${String(counts.waiting_on_agent)} waiting on agents`]
      : []),
    ...today,
  ];
  return parts.length === 0
    ? "Nothing needs you.  All quiet."
    : `Nothing needs you.  ${parts.join(" · ")}`;
}

/** Shape one projection for drawing at `width` cells, as of `now`. */
export function boardView(
  view: BoardProjection,
  options: Readonly<{ width: number; now: number }>,
): BoardView {
  const compact = options.width <= compactWidth;
  const needs = view.needsYou.map((item) =>
    needsRow(item, options.now, compact),
  );
  const lanes = view.lanes.shown.map((lane) => laneRow(lane, options.now));
  const failure = view.readFailure ?? null;
  const shipped = shippedSection(view);
  // A source that could not be read keeps the board from looking calm.
  const sourceTrouble = view.shipping.some((source) => source.state !== "ok");
  const calm =
    needs.length === 0 &&
    lanes.length === 0 &&
    !view.expanded.lanes &&
    !view.expanded.shipping &&
    !sourceTrouble &&
    failure === null;
  // A calm board is its one line; the shipped section joins it only when
  // something else is on screen.
  const sections: BoardSection[] = calm
    ? []
    : [
        ...(needs.length === 0
          ? []
          : [
              {
                id: "needs" as const,
                title:
                  view.needsYouMore > 0
                    ? `NEEDS YOU ${String(needs.length + view.needsYouMore)} · ${String(view.needsYouMore)} more not listed`
                    : `NEEDS YOU ${String(needs.length)}`,
                rows: needs,
                notes: [],
                problems: [],
              },
            ]),
        ...(lanes.length === 0
          ? []
          : [
              {
                id: "lanes" as const,
                title: view.expanded.lanes
                  ? `ALL LANES ${String(lanes.length)}`
                  : `STUCK ${String(lanes.length)}`,
                rows: lanes,
                notes: [],
                problems: [],
              },
            ]),
        ...(shipped === undefined ? [] : [shipped]),
      ];
  return {
    compact,
    calm: calm ? calmLine(view, compact) : null,
    failure: failure === null ? null : `Could not read the Agents: ${failure}`,
    readAt: clock(view.readAt),
    sections,
    summary: calm ? null : laneSummary(view),
    selectable: sections.flatMap((section) =>
      section.rows.filter((row) => row.open !== undefined),
    ),
  };
}
