import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import type { KeyEvent } from "@opentui/core";
import type { KeyHint } from "@fungi.computer/parakeet/headless";
import { InteractionView } from "./interaction-dialog.js";
import {
  approvalCardCopy,
  approvalRefusal,
  approvalState,
  type ApprovalReview,
} from "./approval-card-copy.js";
import { ModalDetails, ModalHeader, modalContentWidth } from "./modal.js";
import { useCopyAction } from "./copy-surface.js";
import { HintRow } from "./hint-row.js";
import { reportFailure } from "./log-event.js";
import { terminalText } from "./terminal-text.js";
import type { TuiPresentation } from "./presentation.js";
import type { DialogController } from "./dialog.js";
import {
  MAX_APPROVAL_DENIAL_NOTE_LENGTH,
  type ApprovalView,
  type Approvals,
} from "@fungi.computer/approvals";
import type { McpFormAnswerResult } from "@fungi.computer/truffle";
import { approvals } from "@fungi.computer/agar/approvals";

/** The owner projects a current ApprovalView and supplies a member-bound answer. */
export type McpApprovalSource = Readonly<{
  snapshot: () => ApprovalView | undefined;
  subscribe: (listener: () => void) => () => void;
  review?: ApprovalReview;
  // Session attachment refusals are not synthesized canonical ledger decisions.
  answer: (
    input: Omit<Parameters<Approvals["answer"]>[0], "decision"> & {
      decision: "approve" | "deny" | "always-allow";
    },
  ) => Promise<Exclude<McpFormAnswerResult, { kind: "submitted" }>>;
}>;

const noApproval = () => undefined;
const noSubscription = () => () => undefined;

/**
 * Read one host-selected ledger view through Agar, never from form text.
 * This is one presentation snapshot; a host refresh replaces the source.
 */
export async function loadMcpApprovalSource(
  capability: unknown,
  recordId: string,
): Promise<McpApprovalSource | undefined> {
  const client = approvals.schema.parse(capability);
  const view = await client.get({ recordId });
  if (view === null) return undefined;
  return {
    snapshot: () => view,
    subscribe: noSubscription,
    answer: (input) =>
      input.decision === "always-allow"
        ? Promise.resolve({ kind: "refused", reason: "not-eligible" })
        : client.answer({ ...input, decision: input.decision }),
  };
}

/** Route an owner's pending approval into the existing conversation dialog. */
export function useMcpApprovalDialog({
  source,
  dialog,
  colors,
  enabled,
}: Readonly<{
  source: McpApprovalSource | undefined;
  dialog: Pick<DialogController, "show">;
  colors: TuiPresentation["colors"];
  enabled: boolean;
}>) {
  const pending = useSyncExternalStore(
    source?.subscribe ?? noSubscription,
    source?.snapshot ?? noApproval,
  );
  const [dismissed, setDismissed] = useState<
    Pick<ApprovalView["record"], "recordId" | "revision"> | undefined
  >(undefined);
  const visible =
    pending !== undefined &&
    !(
      dismissed?.recordId === pending.record.recordId &&
      dismissed.revision === pending.record.revision
    );
  useEffect(() => {
    if (!enabled || !visible || source === undefined) return;
    let current = true;
    const handle = dialog.show(
      () => (
        <McpApprovalPrompt
          source={source}
          colors={colors}
          onClose={() => {
            handle.dismiss();
          }}
        />
      ),
      {
        onDismiss: () => {
          // Escape dismisses this presentation; it is not a durable denial.
          if (current) setDismissed(pending.record);
        },
      },
    );
    return () => {
      current = false;
      handle.dismiss();
    };
  }, [source, pending, dialog.show, colors, enabled, visible]);
  return visible;
}

/** Display metadata only. Raw effect input/output never crosses this seam. */
export function McpApprovalPrompt({
  source,
  colors,
  onClose,
}: Readonly<{
  source: McpApprovalSource;
  colors: TuiPresentation["colors"];
  onClose: () => void;
}>) {
  const pending = useSyncExternalStore(source.subscribe, source.snapshot);
  return pending === undefined ? null : (
    <ActiveApproval
      key={JSON.stringify([pending.record.recordId, pending.record.revision])}
      source={source}
      pending={pending}
      colors={colors}
      onClose={onClose}
    />
  );
}

function ActiveApproval({
  source,
  pending,
  colors,
  onClose,
}: Readonly<{
  source: McpApprovalSource;
  pending: ApprovalView;
  colors: TuiPresentation["colors"];
  onClose: () => void;
}>) {
  const [host] = useState(() =>
    createWhistleInteractionHost({ title: "Approval" }),
  );
  const hostState = useSyncExternalStore(host.subscribe, host.snapshot);
  const [details, setDetails] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const cancelledExplanation = useRef(false);
  const explaining = hostState.prompt?.request.type === "text";
  const dimensions = useTerminalDimensions();
  const compact = dimensions.height < 14;
  const width = modalContentWidth(dimensions.width);
  const card = approvalCardCopy(pending, source.review, width);
  const confirmation = card.confirmation;
  const confirmWarning = card.confirmWarning;
  const showConfirmWarning =
    confirming && confirmation !== undefined && confirmWarning !== undefined;
  const copy = useCopyAction();
  const onKey = (key: KeyEvent) => {
    if (host.snapshot().prompt?.request.type === "text") {
      if (key.name !== "escape") return false;
      const prompt = host.snapshot().prompt;
      if (prompt?.request.type === "text") {
        cancelledExplanation.current = true;
        host.answer(prompt.sequence, "");
      }
      return true;
    }
    if (key.name === "d") {
      setDetails((old) => !old);
      return true;
    }
    if (key.name === "c" && details && card.copyCommand !== undefined) {
      copy?.(card.copyCommand);
      return true;
    }
    if (key.name === "escape" && confirming && !details) {
      const prompt = host.snapshot().prompt;
      if (prompt?.request.type === "choice")
        host.answer(prompt.sequence, "back");
      return true;
    }
    return false;
  };
  useEffect(() => {
    const session = host.begin();
    const record = pending.record;
    const stillCurrent = () => {
      const view = source.snapshot();
      return (
        !session.interaction.signal.aborted &&
        view?.record.recordId === record.recordId &&
        view.record.revision === record.revision &&
        view.canAnswer
      );
    };
    if (!pending.canAnswer) session.settle({ status: "handled" });
    else {
      void (async () => {
        try {
          let decision: "approve" | "deny" | "always-allow" | "back" = "back";
          let denialNote: string | undefined;
          while (decision === "back") {
            const selected = await session.interaction.prompt({
              type: "choice",
              message: "Approval",
              options: [
                { label: "Approve once", value: "approve" },
                ...(card.always === undefined
                  ? []
                  : [{ label: card.always, value: "always" }]),
                { label: "Deny", value: "deny" },
                { label: "Deny and say why…", value: "explain" },
              ],
            });
            if (!stillCurrent()) return;
            if (selected === "explain") {
              const explanation = await session.interaction.prompt({
                type: "text",
                message: "Why deny?",
                placeholder: "A short reason for the Agent (optional)",
              });
              if (!stillCurrent()) return;
              if (cancelledExplanation.current) {
                cancelledExplanation.current = false;
                decision = "back";
                setHighlighted(0);
              } else {
                denialNote = explanation.trim() || undefined;
                decision = "deny";
              }
            } else if (selected === "always") {
              setConfirming(true);
              setHighlighted(0);
              const confirmed = await session.interaction.prompt({
                type: "choice",
                message: "Approval",
                options: [
                  { label: "Back", value: "back" },
                  { label: card.confirmYes ?? "", value: "always-allow" },
                ],
              });
              if (!stillCurrent()) return;
              decision = confirmed === "always-allow" ? "always-allow" : "back";
              setConfirming(false);
              if (decision === "back") setHighlighted(0);
            } else if (selected === "approve" || selected === "deny")
              decision = selected;
          }
          if (!stillCurrent()) return;
          const answer = {
            recordId: record.recordId,
            decision,
            expectedRevision: record.revision,
          } satisfies Parameters<McpApprovalSource["answer"]>[0];
          const result = await source.answer(
            denialNote === undefined ? answer : { ...answer, denialNote },
          );
          if (!stillCurrent()) return;
          if (result.kind === "refused") {
            session.settle({
              status: "failed",
              message: approvalRefusal(result.reason, decision),
            });
          } else {
            session.settle({ status: "handled" });
            onClose();
          }
        } catch (cause) {
          if (session.interaction.signal.aborted) return;
          reportFailure("mcp-approval-answer", cause);
          session.settle({
            status: "failed",
            message:
              "Couldn't send your answer. It may not have been recorded.",
          });
        }
      })();
    }
    return () => {
      host.cancel();
    };
  }, [source, pending, host, onClose, card.always, card.confirmYes]);
  const hints: KeyHint[] = details
    ? [
        { keys: "d", label: "hide details", priority: 0 },
        ...(card.copyCommand === undefined
          ? []
          : [{ keys: "c", label: "copy command", priority: 2 }]),
        { keys: "Esc", label: confirming ? "back" : "later", priority: 1 },
      ]
    : explaining
      ? [
          { keys: "Enter", label: "deny", priority: 0 },
          { keys: "Esc", label: "back", priority: 1 },
        ]
      : [
          { keys: "Enter", label: "select", priority: 0 },
          { keys: "Esc", label: confirming ? "back" : "later", priority: 1 },
          { keys: "d", label: "details", priority: 2 },
          { keys: "↑↓", label: "choose", priority: 3 },
        ];
  return (
    <box flexDirection="column" rowGap={compact ? 0 : 1} width="100%">
      {details ? (
        <box flexDirection="column">
          <ModalDetails
            content={card.content}
            width={width}
            maxRows={dimensions.height - 8}
            colors={colors}
            onKeyDown={(key) => {
              if (key.name === "escape") {
                if (confirming) {
                  const prompt = host.snapshot().prompt;
                  if (prompt?.request.type === "choice")
                    host.answer(prompt.sequence, "back");
                  setDetails(false);
                } else {
                  host.cancel();
                  onClose();
                }
                key.preventDefault();
              } else if (onKey(key)) key.preventDefault();
            }}
          />
          <HintRow hints={hints} width={width} colors={colors} />
        </box>
      ) : (
        <>
          <ModalHeader
            content={
              showConfirmWarning
                ? { title: confirmation.title }
                : confirming
                  ? (confirmation ?? card.content)
                  : card.content
            }
            width={width}
            compact={compact}
            colors={colors}
          />
          {showConfirmWarning ? (
            <box flexDirection="column" rowGap={compact ? 0 : 1}>
              <text fg={colors.foreground} attributes={2} wrapMode="word">
                {terminalText(confirmWarning)}
              </text>
              <text fg={colors.foreground} wrapMode="word">
                {terminalText(confirmation.body)}
              </text>
            </box>
          ) : null}
          {!pending.canAnswer ? (
            <text fg={colors.info}>{approvalState(pending.record.state)}</text>
          ) : null}
          <InteractionView
            host={host}
            colors={colors}
            onClose={onClose}
            onKey={onKey}
            hints={hints}
            hideChoiceTitle
            hideProgressWhilePrompt
            initialIndex={highlighted}
            onHighlight={setHighlighted}
            textMaxLength={MAX_APPROVAL_DENIAL_NOTE_LENGTH}
          />
        </>
      )}
    </box>
  );
}
