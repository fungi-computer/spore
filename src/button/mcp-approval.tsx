import { useEffect, useState, useSyncExternalStore } from "react";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { InteractionView } from "./interaction-dialog.js";
import { reportFailure } from "./log-event.js";
import type { TuiPresentation } from "./presentation.js";
import type { DialogController } from "./dialog.js";
import type { ApprovalView, Approvals } from "@fungi.computer/approvals";
import type { McpFormAnswerResult } from "@fungi.computer/truffle";
import { approvals } from "@fungi.computer/agar/approvals";

/** The owner projects a current ApprovalView and supplies a member-bound answer. */
export type McpApprovalSource = Readonly<{
  snapshot: () => ApprovalView | undefined;
  subscribe: (listener: () => void) => () => void;
  review?: Readonly<{
    command: string;
    cwd: string;
    justification: string;
    prefix?: readonly string[];
    warning?: string;
    alwaysAllowCoverage?: string;
    alwaysAllowUnavailableReason?: string;
  }>;
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
    session.interaction.notify({
      type: "progress",
      message: pending.canAnswer
        ? "Waiting for approval"
        : `Approval: ${record.state} (read-only)`,
    });
    if (!pending.canAnswer) session.settle({ status: "handled" });
    else {
      void (async () => {
        try {
          const prefix = source.review?.prefix?.join(" ");
          const options = [
            { value: "approve", label: "Approve once" },
            ...(prefix === undefined
              ? []
              : [
                  {
                    value: "always-allow",
                    label: `Always allow '${prefix}'`,
                  },
                ]),
            { value: "deny", label: "Deny" },
          ];
          const selected = await session.interaction.prompt({
            type: "choice",
            message: record.description.title,
            options,
          });
          if (
            selected !== "approve" &&
            selected !== "deny" &&
            selected !== "always-allow"
          )
            throw new Error("The approval choice is unavailable.");
          if (selected === "always-allow" && prefix === undefined)
            throw new Error("The approval rule is unavailable.");
          if (!stillCurrent()) return;
          const result = await source.answer({
            recordId: record.recordId,
            decision: selected,
            expectedRevision: record.revision,
          });
          if (!stillCurrent()) return;
          if (result.kind === "refused") {
            session.settle({
              status: "failed",
              message: `Approval refused: ${result.reason}`,
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
            message: "Could not answer approval. The outcome is not confirmed.",
          });
        }
      })();
    }
    return () => {
      host.cancel();
    };
  }, [source, pending, host, onClose]);
  const { record } = pending;
  return (
    <box flexDirection="column">
      <text fg={colors.foreground}>{record.description.title}</text>
      {source.review === undefined ? null : (
        <>
          <text
            fg={colors.foreground}
          >{`Command: ${source.review.command}`}</text>
          <text
            fg={colors.foreground}
          >{`Working directory: ${source.review.cwd}`}</text>
          <text
            fg={colors.foreground}
          >{`Justification: ${source.review.justification}`}</text>
          {source.review.prefix === undefined ? null : (
            <text fg={colors.foreground}>
              {`Always allow ${source.review.prefix.join(" ")}: ${source.review.warning ?? "matching direct commands run as you, outside the sandbox, without asking again"}`}
            </text>
          )}
          {source.review.prefix === undefined &&
          source.review.warning !== undefined ? (
            <text
              fg={colors.foreground}
            >{`Warning: ${source.review.warning}`}</text>
          ) : null}
          {source.review.prefix !== undefined &&
          source.review.alwaysAllowCoverage !== undefined ? (
            <text fg={colors.foreground}>
              {`Always allow scope: ${source.review.alwaysAllowCoverage}`}
            </text>
          ) : null}
          {source.review.prefix === undefined &&
          source.review.alwaysAllowUnavailableReason !== undefined ? (
            <text fg={colors.foreground}>
              {`Details: ${source.review.alwaysAllowUnavailableReason}`}
            </text>
          ) : null}
        </>
      )}
      <text
        fg={colors.foreground}
      >{`Requester: ${record.requester.displayName}`}</text>
      <text
        fg={colors.foreground}
      >{`Principal: ${record.requester.principalId}`}</text>
      <text
        fg={colors.foreground}
      >{`Agent: ${record.requester.agentId ?? "none"} · Session: ${record.requester.sessionId ?? "none"}`}</text>
      <text
        fg={colors.foreground}
      >{`${record.module}.${record.operation} · ${record.access}`}</text>
      <text
        fg={colors.foreground}
      >{`Reversibility: ${record.reversibility}`}</text>
      <text
        fg={colors.foreground}
      >{`Input: ${String(record.description.inputBytes)} bytes`}</text>
      <text
        fg={colors.foreground}
      >{`SHA-256: ${record.description.inputSha256}`}</text>
      <InteractionView host={host} colors={colors} onClose={onClose} />
    </box>
  );
}
