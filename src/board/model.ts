import type {
  SessionAttention,
  SessionSummaryRow,
} from "@fungi.computer/shiitake/client";
import {
  maximumWaitingPerAgent,
  type BoardAgent,
} from "@fungi.computer/truffle/board-agents";
import type {
  ShipItem,
  ShippingRead,
} from "@fungi.computer/truffle/board-shipping";

/** The most person-bound items the board lists; the rest are counted. */
const maximumNeedsYou = 16;
/** The most lanes the board lists; the rest are counted. */
const maximumShownLanes = 16;

/**
 * What one Agent is doing, from its newest conversation. `waiting_on_you` has
 * a row in NEEDS YOU; `waiting_on_agent` waits on another Agent's answer;
 * `stopped` is stored as working while no live runtime holds its store;
 * `unavailable` means the state could not be read and is never idle.
 */
export type LaneState =
  | "working"
  | "waiting_on_you"
  | "waiting_on_agent"
  | "stuck"
  | "failed"
  | "stopped"
  | "unavailable"
  | "idle";

/** One item waiting on a person, from an Agent's own open attention. */
export type NeedsYou = Readonly<{
  /** Stable across reads: agent, conversation, extension and item. */
  id: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  sessionTitle: string;
  /** The asker's word for what it wants: question, approval, and so on. */
  kind: string;
  /** The asker's own one-line summary; display data that grants nothing. */
  summary: string;
  /** When the wait began. */
  since: number;
  expiresAt?: number;
}>;

/** One Agent's lane; the Agent name is the area, so areas cannot drift. */
export type Lane = Readonly<{
  agentId: string;
  name: string;
  /** Its newest conversation; null when it has none. */
  sessionId: string | null;
  state: LaneState;
  /** When this state began, as far as the store says. */
  since: number | null;
  /** What the store says about the state, such as a stuck goal's summary. */
  detail?: string;
}>;

/** Every Agent read once, ordered most pressing first. */
export type BoardRows = Readonly<{
  readAt: number;
  needs: readonly NeedsYou[];
  lanes: readonly Lane[];
  /** Why the last read failed; the lists are from the last one that worked. */
  failure?: string;
}>;

/** One shipping source's latest read; a failed read is a state, never zero items. */
export type SourceRead = Readonly<{
  sourceId: string;
  label: string;
  state: ShippingRead["state"] | "failed";
  readAt: number;
  detail?: string;
  items: readonly ShipItem[];
}>;

/** What a person asked to see beyond the few rows that need a look. */
export type Expanded = Readonly<{ lanes: boolean; shipping: boolean }>;

/** Lane counts per state. */
export type LaneCounts = Readonly<Record<LaneState, number>>;

/** The board: person-bound items first, then the lanes that need a look. */
export type BoardProjection = Readonly<{
  readAt: number;
  needsYou: readonly NeedsYou[];
  needsYouMore: number;
  lanes: Readonly<{
    shown: readonly Lane[];
    more: number;
    counts: LaneCounts;
  }>;
  readFailure?: string;
  shipping: readonly SourceRead[];
  expanded: Expanded;
}>;

/** Goal states that mean it needs a person's look but does not wait on one. */
const stuckKinds = new Set(["goal-blocked", "goal-stalled"]);
/** Kinds another Agent answers when attention is routed away from the person. */
const routedKinds = new Set(["question", "approval"]);

const cut = (value: string, limit: number) =>
  value.length <= limit ? value : value.slice(0, limit - 1) + "…";

/** Local midnight at or before `now`. */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Lanes order most pressing first. */
const laneOrder = {
  stuck: 0,
  failed: 1,
  stopped: 2,
  unavailable: 3,
  waiting_on_you: 4,
  waiting_on_agent: 5,
  working: 6,
  idle: 7,
} as const satisfies Record<LaneState, number>;
/** The states a collapsed board lists. */
const listedCollapsed = new Set<LaneState>([
  "stuck",
  "failed",
  "stopped",
  "unavailable",
]);

/** The conversation's stored state, as a person reads it. */
function stateOf(
  row: SessionSummaryRow,
): "working" | "idle" | "failed" | "unavailable" | "waiting" {
  switch (row.state) {
    case "running":
      return "working";
    case "needs_you":
      return "waiting";
    case "errored":
      return "failed";
    case "done":
      return "idle";
    case "unavailable":
      return "unavailable";
  }
}

/** When a conversation last settled, else last changed. */
const atOf = (row: SessionSummaryRow) =>
  row.state === "unavailable"
    ? undefined
    : (row.settledAt ?? row.lastActivityAt);

function laneOf(
  base: Pick<Lane, "agentId" | "name">,
  row: SessionSummaryRow,
  attention: readonly SessionAttention[],
  owned: boolean,
  now: number,
): Lane {
  const lane = (
    state: LaneState,
    since: number | null,
    detail?: string,
  ): Lane => {
    const shared = { ...base, sessionId: row.sessionId, state, since };
    return detail === undefined
      ? shared
      : { ...shared, detail: cut(detail, 200) };
  };
  const stuck = attention.find((item) => stuckKinds.has(item.kind));
  if (stuck !== undefined) return lane("stuck", stuck.since, stuck.summary);
  const state = stateOf(row);
  if (state === "unavailable") return lane("unavailable", null);
  const personal = attention.find((item) => item.inbox !== false);
  if (personal !== undefined)
    return lane("waiting_on_you", personal.since, personal.summary);
  const routed = attention.find(
    (item) => item.inbox === false && routedKinds.has(item.kind),
  );
  if (routed !== undefined)
    return lane("waiting_on_agent", routed.since, routed.summary);
  const at = atOf(row) ?? null;
  const working =
    state === "working" ||
    attention.some((item) => item.kind === "goal-waiting");
  // Only a live runtime works; a store nobody holds says what was left behind.
  if (working) return owned ? lane("working", at) : lane("stopped", at);
  if (state === "failed" && at !== null && at >= startOfDay(now))
    return lane("failed", at);
  return lane("idle", at);
}

function needsYouFor(
  agent: Pick<Lane, "agentId" | "name">,
  sessionId: string,
  sessionTitle: string,
  item: SessionAttention,
): NeedsYou {
  const shared = {
    id: [agent.agentId, sessionId, item.extensionId, item.id].join("/"),
    agentId: agent.agentId,
    agentName: agent.name,
    sessionId,
    sessionTitle: cut(sessionTitle, 200),
    kind: item.kind,
    summary: cut(item.summary, 200),
    since: item.since,
  };
  return item.expiresAt === undefined
    ? shared
    : { ...shared, expiresAt: item.expiresAt };
}

/** One Agent's lane and what it asks of a person. */
type AgentRead = Readonly<{ lane: Lane; needs: readonly NeedsYou[] }>;

/** One Agent's lane and what it asks of a person, from what its store says. */
function readAgent(agent: BoardAgent, now: number): AgentRead {
  const base = {
    agentId: cut(agent.agentId, 256),
    name: cut(agent.name.length === 0 ? agent.agentId : agent.name, 256),
  };
  if (agent.unreadable !== undefined)
    return {
      lane: {
        ...base,
        sessionId: null,
        state: "unavailable",
        since: null,
        detail: cut(agent.unreadable, 200),
      },
      needs: [],
    };
  const first = agent.sessions[0];
  if (first === undefined)
    return {
      lane: { ...base, sessionId: null, state: "idle", since: null },
      needs: [],
    };
  const attentionOf = (sessionId: string) =>
    agent.attention.get(sessionId) ?? [];
  const needs = agent.sessions
    .filter((row) => row.state === "needs_you")
    .slice(0, maximumWaitingPerAgent)
    .flatMap((row) =>
      attentionOf(row.sessionId)
        .filter((item) => item.inbox !== false)
        .map((item) =>
          needsYouFor(
            base,
            row.sessionId,
            row.state === "unavailable" ? "" : row.title,
            item,
          ),
        ),
    );
  return {
    lane: laneOf(base, first, attentionOf(first.sessionId), agent.owned, now),
    needs,
  };
}

/** Read every Agent once into lanes and what waits on a person. */
export function readRows(
  agents: readonly BoardAgent[],
  now: number,
): BoardRows {
  const read = agents.map((agent) => readAgent(agent, now));
  return {
    readAt: now,
    needs: read
      .flatMap((item) => item.needs)
      .sort(
        (left, right) =>
          left.since - right.since || left.id.localeCompare(right.id),
      ),
    lanes: read
      .map((item) => item.lane)
      .sort(
        (left, right) =>
          laneOrder[left.state] - laneOrder[right.state] ||
          (left.since ?? Number.POSITIVE_INFINITY) -
            (right.since ?? Number.POSITIVE_INFINITY) ||
          left.name.localeCompare(right.name),
      ),
  };
}

/** The rows of a failed read: the last good lists, and why this one failed. */
export function failedRows(
  previous: BoardRows | undefined,
  cause: unknown,
  now: number,
): BoardRows {
  return {
    readAt: previous?.readAt ?? now,
    needs: previous?.needs ?? [],
    lanes: previous?.lanes ?? [],
    failure: cut(
      cause instanceof Error ? cause.message : "The Agents could not be read",
      200,
    ),
  };
}

/** Shape the rows, the shipping reads and the person's choices into the board. */
export function project(
  rows: BoardRows,
  shipping: readonly SourceRead[],
  expanded: Expanded,
): BoardProjection {
  const count = (state: LaneState) =>
    rows.lanes.filter((lane) => lane.state === state).length;
  const counts = {
    working: count("working"),
    waiting_on_you: count("waiting_on_you"),
    waiting_on_agent: count("waiting_on_agent"),
    stuck: count("stuck"),
    failed: count("failed"),
    stopped: count("stopped"),
    unavailable: count("unavailable"),
    idle: count("idle"),
  };
  const listed = expanded.lanes
    ? rows.lanes
    : rows.lanes.filter((lane) => listedCollapsed.has(lane.state));
  const projection = {
    readAt: rows.readAt,
    needsYou: rows.needs.slice(0, maximumNeedsYou),
    needsYouMore: Math.max(0, rows.needs.length - maximumNeedsYou),
    lanes: {
      shown: listed.slice(0, maximumShownLanes),
      more: Math.max(0, listed.length - maximumShownLanes),
      counts,
    },
    shipping,
    expanded,
  };
  return rows.failure === undefined
    ? projection
    : { ...projection, readFailure: rows.failure };
}
