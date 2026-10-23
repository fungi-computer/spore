import { terminalText } from "./button/terminal-text.js";
import type {
  SessionFrame,
  SessionMessage,
  SessionSnapshot,
} from "@fungi.computer/shiitake/client";
import type { PrivateLocalServiceSelection } from "@fungi.computer/truffle/service";
import {
  mergeTerminals,
  sessionActivityStatus,
  sessionViewState,
} from "@fungi.computer/parakeet/headless";
import { z } from "zod";

import { userFacingCause } from "./panes/conversation/user-facing-cause.js";
import { sessionDiagnosticLabel } from "./panes/conversation/session-state-label.js";

const sessionInspectionLimit = 100;
const inspectionTextLimit = 4_096;

const typedCauseSchema = z.strictObject({
  error: z.strictObject({
    kind: z.string().min(1).max(80),
    message: z.string().min(1).max(512),
  }),
});

export type SessionInspectionRow = Readonly<{
  commandId: string | null;
  id: string;
  sequence: number;
  role: string;
  value: SessionMessage["value"];
  data?: SessionMessage["data"];
  error?: Readonly<{ kind: string; message: string }> | undefined;
}>;

export type SessionInspectionStateCause = Readonly<{
  kind: "extension_stopped" | "session_error";
  message: string;
  extensionId?: string | undefined;
}>;

function typedCause(message: SessionMessage) {
  if (message.value.role !== "toolResult" || !message.value.isError)
    return undefined;
  const decoded = typedCauseSchema.safeParse(message.data);
  if (decoded.success) return decoded.data.error;
  const content = message.value.content.find(
    (part): part is Extract<typeof part, { type: "text" }> =>
      part.type === "text",
  );
  return {
    kind: "tool_error",
    message: content?.text.slice(0, 512) ?? "The tool reported an error.",
  };
}

export function inspectionRows(
  snapshot: SessionSnapshot,
  errorsOnly: boolean,
): readonly SessionInspectionRow[] {
  return snapshot.messages.flatMap((message) => {
    const error = typedCause(message);
    if (errorsOnly && error === undefined) return [];
    const row = {
      id: message.id,
      sequence: message.sequence,
      commandId: message.commandId,
      role: message.value.role,
      value: message.value,
      data: message.data,
    };
    return error === undefined ? [row] : [{ ...row, error }];
  });
}

function boundedText(value: string): string {
  const normalized = value.trim();
  return normalized.length <= inspectionTextLimit
    ? normalized
    : `${normalized.slice(0, inspectionTextLimit)}…`;
}

function textContent(message: SessionMessage["value"]): string {
  if (message.role === "system")
    return boundedText(
      Array.isArray(message.content)
        ? message.content.map((part) => part.text).join("\n")
        : message.content,
    );
  if (message.role === "user")
    return boundedText(
      Array.isArray(message.content)
        ? message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
        : message.content,
    );
  if (message.role === "assistant")
    return boundedText(
      message.content
        .flatMap((part) => {
          if (part.type === "text") return [part.text];
          if (part.type === "toolCall")
            return [`${part.name}(${JSON.stringify(part.arguments)})`];
          return [];
        })
        .join("\n"),
    );
  return boundedText(
    message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n"),
  );
}

export function inspectionStateCauses(
  snapshot: SessionSnapshot,
): readonly SessionInspectionStateCause[] {
  const causes: SessionInspectionStateCause[] = [];
  const view = sessionViewState(snapshot);
  if (view.kind === "error")
    causes.push({ kind: "session_error", message: view.cause });
  for (const [extensionId, slot] of Object.entries(snapshot.extensions))
    if (slot.status === "stopped")
      causes.push({
        kind: "extension_stopped",
        extensionId,
        message: slot.reason,
      });
  return causes;
}

export function renderInspection(
  snapshot: SessionSnapshot,
  errorsOnly: boolean,
  json: boolean,
): string {
  const rows = inspectionRows(snapshot, errorsOnly);
  const states = inspectionStateCauses(snapshot);
  if (json)
    return `${JSON.stringify({
      sessionId: snapshot.sessionId,
      bounded: { limit: sessionInspectionLimit, hasMore: snapshot.hasMore },
      activity: snapshot.activity,
      viewState: sessionViewState(snapshot),
      messages: rows,
      errors: states,
      terminals: snapshot.terminals,
      sandboxFailures: snapshot.sandboxFailures ?? [],
      pending: snapshot.pending,
    })}\n`;
  const lines = [
    `Session ${snapshot.sessionId} · ${sessionActivityStatus(sessionViewState(snapshot))}${snapshot.hasMore ? ` · latest ${String(sessionInspectionLimit)} messages` : ""}`,
  ];
  for (const failure of snapshot.sandboxFailures ?? [])
    lines.push(
      `[sandbox_failure:${failure.tag}] ref ${failure.ref} · ${failure.adapter}${failure.healthAlert ? " · health alert" : ""}`,
    );
  for (const state of states)
    lines.push(
      state.extensionId === undefined
        ? `[${state.kind}]: ${userFacingCause(state.message)}`
        : `[${state.kind}:${state.extensionId}]: ${userFacingCause(state.message)}`,
    );
  for (const row of rows) {
    const text = textContent(row.value).trim();
    lines.push(
      row.error === undefined
        ? `${String(row.sequence)} ${row.role}${text === "" ? "" : `: ${text}`}`
        : `${String(row.sequence)} ${row.role} [${row.error.kind}]: ${userFacingCause(row.error.message)}`,
    );
  }
  for (const terminal of snapshot.terminals) {
    const reason =
      terminal.diagnostic === null
        ? ""
        : `: ${userFacingCause(terminal.diagnostic)}`;
    lines.push(`Run ${terminal.commandId} · ${terminal.outcome}${reason}`);
  }
  return `${lines.map(terminalText).join("\n")}\n`;
}

function newestTerminal(
  terminals: SessionSnapshot["terminals"],
): SessionSnapshot["terminals"][number] | null {
  let newest: SessionSnapshot["terminals"][number] | null = null;
  for (const terminal of terminals)
    if (newest === null || terminal.sequence > newest.sequence)
      newest = terminal;
  return newest;
}

/**
 * Stable owner state for automation and a concise human readout. The JSON
 * carries Shiitake's raw activity facts, the Parakeet view state and its
 * label, and the newest terminal with its exact diagnostic, so an error is
 * never reduced to a label.
 */
export function renderSessionStatus(
  snapshot: SessionSnapshot,
  lastActivityAt: number,
  json: boolean,
  now = Date.now(),
): string {
  const view = sessionViewState(snapshot);
  if (json)
    return `${JSON.stringify({
      schemaVersion: 2,
      sessionId: snapshot.sessionId,
      state: view.kind,
      label: sessionDiagnosticLabel(view, now),
      viewState: view,
      activity: snapshot.activity,
      lastTerminal: newestTerminal(snapshot.terminals),
      lastActivityAt,
    })}\n`;
  const label = view.kind.replaceAll("_", " ");
  const cause = view.kind === "error" ? `: ${userFacingCause(view.cause)}` : "";
  return `${terminalText(`Session ${snapshot.sessionId} · ${label}${cause}`)}\n`;
}

function applyFrame(
  snapshot: SessionSnapshot,
  frame: SessionFrame,
): SessionSnapshot {
  if (frame.kind === "reset") return frame.baseline;
  if (frame.kind === "tool_output")
    return {
      ...snapshot,
      activity: frame.activity,
      toolOutput: frame.toolOutput,
    };
  if (frame.kind === "progress")
    return {
      ...snapshot,
      activity: frame.activity,
      progress: frame.progress,
    };
  return {
    ...snapshot,
    cursor: frame.cursor,
    messages: [...snapshot.messages, ...frame.messages].slice(
      -sessionInspectionLimit,
    ),
    terminals: mergeTerminals(snapshot.terminals, frame.terminals),
    sandboxFailures: [
      ...(snapshot.sandboxFailures ?? []),
      ...(frame.sandboxFailures ?? []),
    ].slice(-sessionInspectionLimit),
    pending: frame.pending,
    activity: frame.activity,
    extensions: frame.extensions,
    progress: null,
  };
}

export async function runSessionInspection(input: {
  inspect: (
    selection: PrivateLocalServiceSelection,
    options: Readonly<{ limit: number; signal?: AbortSignal | undefined }>,
  ) => Promise<
    Readonly<{
      snapshot: SessionSnapshot;
      session: Readonly<{
        watch: (options?: { includeSandboxFailures: boolean }) => Promise<{
          changes: AsyncIterable<SessionFrame>;
          close: () => Promise<void>;
        }>;
      }>;
      close: () => Promise<void>;
    }>
  >;
  selection: PrivateLocalServiceSelection;
  watch: boolean;
  errorsOnly: boolean;
  json: boolean;
  signal?: AbortSignal | undefined;
  signals?:
    | Readonly<{
        on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
        off: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
      }>
    | undefined;
  write: (value: string) => void;
}): Promise<void> {
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  const signals = input.signals ?? process;
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  let inspected: Awaited<ReturnType<typeof input.inspect>> | undefined;
  try {
    inspected = await input.inspect(input.selection, {
      limit: sessionInspectionLimit,
      signal: input.signal ?? controller.signal,
    });
    let snapshot = inspected.snapshot;
    input.write(renderInspection(snapshot, input.errorsOnly, input.json));
    if (!input.watch) return;
    const watch = await inspected.session.watch({
      includeSandboxFailures: true,
    });
    try {
      for await (const frame of watch.changes) {
        if (controller.signal.aborted || input.signal?.aborted) break;
        snapshot = applyFrame(snapshot, frame);
        input.write(renderInspection(snapshot, input.errorsOnly, input.json));
      }
    } finally {
      await watch.close();
    }
  } finally {
    if (inspected !== undefined) await inspected.close();
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  }
}
