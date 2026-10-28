import type { ApprovalReview } from "@fungi.computer/parakeet/headless";
import type { ApprovalView, Approvals } from "@fungi.computer/approvals";
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
