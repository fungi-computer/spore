import { homedir } from "node:os";
import type { ApprovalView } from "@fungi.computer/approvals";
import type { ModalContent } from "./modal.js";

export type ApprovalReview = Readonly<{
  command: string;
  cwd: string;
  justification: string;
  form: "direct" | "shell";
  kind: "exec" | "extension-install";
  argv?: readonly string[];
  prefix?: readonly string[];
  warning?: string;
  alwaysAllowCoverage?: string;
  alwaysAllowUnavailableReason?: string;
  risk?: Readonly<{ summary: string; detail: string }>;
}>;

const shorten = (value: string, width: number) => {
  if (value.length <= width) return value;
  const left = Math.max(1, Math.floor((width - 1) / 2));
  return `${value.slice(0, left)}…${value.slice(-(width - left - 1))}`;
};
const lead = (value: string, width: number) =>
  value.length <= width ? value : `${value.slice(0, width - 1)}…`;

export type ApprovalCard = {
  content: ModalContent;
  always?: string | undefined;
  confirmation?: (ModalContent & { body: string }) | undefined;
  confirmWarning?: string | undefined;
  confirmYes?: string | undefined;
  copyCommand?: string | undefined;
};

const entries = (pairs: readonly [string, string][]) =>
  pairs.map(([label, value]) => ({ label, value }));

function recordDetails(view: ApprovalView): [string, string][] {
  const { record } = view;
  return [
    [
      "Agent",
      `${record.requester.displayName} · ${record.requester.agentId ?? "none"}`,
    ],
    ["Session", record.requester.sessionId ?? "none"],
    ["Requester", record.requester.principalId],
    ["Request", `${record.module}.${record.operation} · ${record.access}`],
    [
      "Input",
      `${record.description.inputBytes.toLocaleString()} bytes · SHA-256 ${record.description.inputSha256.slice(0, 8)}…${record.description.inputSha256.slice(-6)}`,
    ],
    [
      "Expires",
      `in ${String(Math.max(0, Math.floor((record.expiresAt - Date.now()) / 3_600_000)))} h ${String(Math.max(0, Math.floor(((record.expiresAt - Date.now()) % 3_600_000) / 60_000)))} m`,
    ],
    ["Record", `${record.recordId} · revision ${String(record.revision)}`],
  ];
}

function undoDetail(view: ApprovalView): [string, string] {
  return [
    "Undo",
    view.record.reversibility === "irreversible-external"
      ? "Can't be undone"
      : "Can be undone",
  ];
}

function connectedToolCard(view: ApprovalView): ApprovalCard {
  const { record } = view;
  return {
    content: {
      title: `Allow ${record.module} · ${record.operation}?`,
      summary: `${record.requester.displayName} wants to use a connected tool.`,
      facts: [
        {
          label: "Effect",
          value:
            (record.access === "write"
              ? "Changes data in Fungi"
              : "Changes things outside Fungi") +
            (record.reversibility === "irreversible-external"
              ? " · can't be undone"
              : ""),
        },
      ],
      details: entries([undoDetail(view), ...recordDetails(view)]),
    },
  };
}

function escapeCard(
  view: ApprovalView,
  review: ApprovalReview,
  width: number,
): ApprovalCard {
  const prefix = review.prefix?.join(" ");
  const offered =
    prefix !== undefined && review.alwaysAllowUnavailableReason === undefined;
  const command = review.command;
  const title =
    `Allow \`${command}\`?`.length <= width
      ? `Allow \`${command}\`?`
      : "Allow this command?";
  const folder =
    review.cwd === homedir()
      ? "~"
      : review.cwd.startsWith(`${homedir()}/`)
        ? `~${review.cwd.slice(homedir().length)}`
        : review.cwd;
  const reasonWidth = Math.max(8, (width - 8) * 2 - 2);
  const reason =
    review.justification.length <= reasonWidth
      ? `“${review.justification}”`
      : `“${review.justification.slice(0, reasonWidth - 1)}…”`;
  const facts: [string, string][] = [
    ["Folder", shorten(folder, Math.max(8, width - 10))],
    ["Why", reason],
  ];
  if (review.kind === "extension-install")
    facts.push([
      "Note",
      "Extensions run inside Fungi with access to every Agent.",
    ]);
  // The complete host-provided coverage stays in Details; the main card has a
  // one-line preview so long Git option lists cannot displace the choices.
  if (offered && review.alwaysAllowCoverage !== undefined)
    facts.push([
      "Scope",
      lead(review.alwaysAllowCoverage, Math.max(8, width - 12)),
    ]);
  if (!offered && review.warning !== undefined)
    facts.push(["Warning", review.warning]);
  const always = !offered
    ? undefined
    : `Always allow “${shorten(prefix, Math.max(8, width - 5 - "Always allow “” in this project…".length))}” in this project…`;
  const details: [string, string][] = [["Command", command]];
  if (review.argv !== undefined)
    details.push(["Arguments", JSON.stringify(review.argv)]);
  details.push(
    ["Folder", review.cwd],
    ["Runs", "Outside the sandbox, as you"],
    undoDetail(view),
  );
  if (!offered && review.alwaysAllowUnavailableReason !== undefined)
    details.push(["Rule", review.alwaysAllowUnavailableReason]);
  else if (review.form === "shell")
    details.push(["Rule", "Shell command: no Always-allow rule can match it."]);
  else if (offered) {
    details.push([
      "Rule",
      `“${prefix}” would match \`${prefix} …\` in this project`,
    ]);
    if (review.alwaysAllowCoverage !== undefined)
      details.push(["Coverage", review.alwaysAllowCoverage]);
    if (review.risk !== undefined) details.push(["Risk", review.risk.detail]);
  }
  if (!offered && review.warning !== undefined)
    // ModalDetails replaces the preview by label; do not repeat the same
    // once-only warning as a second "Risk" row.
    details.push(["Warning", review.warning]);
  details.push(...recordDetails(view));
  return {
    content: {
      title,
      body: title === "Allow this command?" ? command : undefined,
      bodyLabel: title === "Allow this command?" ? "Command" : undefined,
      summary: `${view.record.requester.displayName} wants to run this outside the sandbox, as you.`,
      facts: entries(facts),
      details: entries(details),
    },
    always:
      always === undefined ? undefined : lead(always, Math.max(12, width - 5)),
    confirmation: !offered
      ? undefined
      : {
          title: `Always allow “${prefix}” in this project?`,
          body: lead(
            review.alwaysAllowCoverage ??
              `Any Workspace Agent here can then run \`${prefix} …\` without asking.`,
            Math.max(12, (width - 8) * 2 - 2),
          ),
        },
    confirmWarning: offered ? review.risk?.summary : undefined,
    confirmYes: !offered
      ? undefined
      : `Always allow “${prefix}” and run it now`,
    copyCommand: command,
  };
}

export function approvalCardCopy(
  view: ApprovalView,
  review: ApprovalReview | undefined,
  width: number,
): ApprovalCard {
  return review === undefined
    ? connectedToolCard(view)
    : escapeCard(view, review, width);
}

export function approvalState(state: ApprovalView["record"]["state"]) {
  switch (state) {
    case "requested":
      return "Approval requested.";
    case "pending":
      return "Waiting for approval.";
    case "approved":
      return "Approved. Waiting to run.";
    case "claimed":
      return "Dispatch in progress.";
    case "applied":
      return "Done.";
    case "denied":
      return "Denied.";
    case "expired":
      return "Expired. Nothing ran.";
    case "outcome_unknown":
      return "Outcome unknown. Check before trying again.";
  }
}

export function approvalRefusal(
  reason: string,
  decision: "approve" | "deny" | "always-allow",
) {
  switch (reason) {
    case "stale-revision":
    case "already-answered":
      return "This request changed. Look again before answering.";
    case "expired":
      return "This request expired. Nothing ran.";
    case "not-eligible":
      if (decision === "always-allow")
        return "Always allow isn't available for this command. Approve once or deny.";
      break;
    default:
      break;
  }
  return `Couldn't answer (${reason}). Nothing ran.`;
}
