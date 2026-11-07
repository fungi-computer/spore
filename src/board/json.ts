import { z } from "zod";
import { laneCounts, type BoardRows } from "./model.js";

const identity = z.string().min(1).max(256);
const text = z.string().max(200);
const count = z.number().int().nonnegative();
const recipient = z.strictObject({
  agentId: identity,
  sessionId: identity,
  name: identity,
});
const escalation = z.strictObject({
  by: recipient,
  reason: z.enum(["escalated", "sender_archived", "sender_absent"]),
  note: z.string().max(1000).nullable(),
});
const needsYou = z.strictObject({
  id: z.string().min(1).max(2048),
  agentId: identity,
  agentName: identity,
  sessionId: identity,
  sessionTitle: text,
  kind: identity,
  summary: text,
  since: count,
  ageMs: count,
  expiresAt: count.nullable(),
  parent: recipient.nullable(),
  escalated: escalation.nullable(),
  escalatedByParent: z.boolean(),
});
const lane = z.strictObject({
  agentId: identity,
  name: identity,
  sessionId: identity.nullable(),
  state: z.enum([
    "stuck",
    "failed",
    "stopped",
    "unavailable",
    "waiting_on_you",
    "waiting_on_agent",
    "working",
    "idle",
  ]),
  since: count.nullable(),
  ageMs: count.nullable(),
  detail: text.nullable(),
  parent: recipient.nullable(),
  waitingOn: recipient.nullable(),
  waitingNotRead: count,
});

/** Versioned headless attention read. Keys are always present; missing facts are null. */
export const boardJsonSchema = z.strictObject({
  schemaVersion: z.literal(1),
  root: z.string().min(1),
  readAt: count,
  readFailure: text.nullable(),
  counts: z.strictObject({
    working: count,
    waiting_on_you: count,
    waiting_on_agent: count,
    stuck: count,
    failed: count,
    stopped: count,
    unavailable: count,
    idle: count,
  }),
  needsYou: z.array(needsYou),
  lanes: z.array(lane),
});
type BoardJson = z.infer<typeof boardJsonSchema>;

/** Full BoardRows, before the interactive display cut; JSON.stringify owns encoding. */
export function renderBoardJson(rows: BoardRows, root: string): string {
  const snapshot: BoardJson = {
    schemaVersion: 1,
    root,
    readAt: rows.readAt,
    readFailure: rows.failure ?? null,
    counts: laneCounts(rows.lanes),
    needsYou: rows.needs.map((item) => ({
      ...item,
      ageMs: Math.max(0, rows.readAt - item.since),
      expiresAt: item.expiresAt ?? null,
      escalated:
        item.escalated === null
          ? null
          : { ...item.escalated, note: item.escalated.note ?? null },
    })),
    lanes: rows.lanes.map((item) => ({
      ...item,
      ageMs: item.since === null ? null : Math.max(0, rows.readAt - item.since),
      detail: item.detail ?? null,
    })),
  };
  return JSON.stringify(boardJsonSchema.parse(snapshot));
}
