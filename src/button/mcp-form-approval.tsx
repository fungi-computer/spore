import { useEffect, useMemo, useRef } from "react";
import {
  useExtensionSlots,
  useStatus,
  type ParakeetSession,
} from "@fungi.computer/parakeet/headless";
import { mcpFormApprovalContract } from "@fungi.computer/truffle";
import * as Schema from "effect/Schema";
import type { McpApprovalSource } from "./mcp-approval-source.js";
import { useToast } from "./toast.js";

const decodeProjection = Schema.decodeUnknownSync(
  mcpFormApprovalContract.projection.schema,
);
const decodeAnswerResult = Schema.decodeUnknownSync(
  mcpFormApprovalContract.commands.answer.output,
);
const noSubscription = () => () => undefined;

/**
 * Adapt the watched Session's canonical view into an approval source for the
 * composer's queue; Local owns attachment and apply.
 */
export function useMcpFormApprovalSource({
  session,
  enabled,
}: Readonly<{
  session: ParakeetSession;
  enabled: boolean;
}>): McpApprovalSource | undefined {
  const slots = useExtensionSlots();
  const { observation } = useStatus();
  const toast = useToast();
  const slot = slots[mcpFormApprovalContract.id];
  const projection = useMemo(() => {
    if (slot?.status !== "running")
      return { pending: undefined, invalid: false };
    try {
      return {
        pending: decodeProjection(slot.value).pending[0],
        invalid: false,
      };
    } catch {
      return { pending: undefined, invalid: true };
    }
  }, [slot]);
  const available = enabled && observation.status === "live";
  const pending = projection.pending;
  const presentationKey = JSON.stringify([
    pending?.id,
    pending?.approval.record.recordId,
    pending?.approval.record.revision,
    pending?.approval.canAnswer,
    pending?.approval.canSetAutoApprove,
  ]);
  const latest = useRef({ session, pending, available, presentationKey });
  latest.current = { session, pending, available, presentationKey };
  const source = useMemo<McpApprovalSource | undefined>(() => {
    const selected = latest.current.pending;
    if (!available || selected === undefined) return undefined;
    const view = selected.approval;
    // Keep the presentation stable when another queued record is appended.
    // Revision/rights/session replacement fences the old source immediately.
    const snapshot = () => {
      const current = latest.current;
      return current.available &&
        current.session === session &&
        current.presentationKey === presentationKey
        ? view
        : undefined;
    };
    const result: McpApprovalSource = {
      snapshot,
      subscribe: noSubscription,
      answer: async (input) => {
        if (
          !snapshot()?.canAnswer ||
          input.recordId !== view.record.recordId ||
          input.expectedRevision !== view.record.revision
        )
          return { kind: "refused", reason: "not-pending" };
        const request = {
          id: selected.id,
          decision: input.decision,
          expectedRevision: input.expectedRevision,
        };
        const result = decodeAnswerResult(
          await session
            .extension(mcpFormApprovalContract.id)
            .call(
              "answer",
              input.denialNote === undefined
                ? request
                : { ...request, denialNote: input.denialNote },
            ),
        );
        if (result.kind === "submitted")
          throw new Error("The host has not confirmed the approval decision.");
        return result;
      },
    };
    return selected.review === undefined
      ? result
      : { ...result, review: selected.review };
  }, [session, available, presentationKey]);
  useEffect(() => {
    if (available && projection.invalid)
      toast.show({
        variant: "error",
        message: "Invalid MCP form approval projection.",
      });
  }, [available, projection.invalid, toast]);
  return source;
}
