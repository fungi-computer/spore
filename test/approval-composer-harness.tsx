import { useMemo, useSyncExternalStore } from "react";
import { MAX_APPROVAL_DENIAL_NOTE_LENGTH } from "@fungi.computer/approvals";
import {
  awaitingQueue,
  createParakeetInteractions,
  useApprovalAwaiting,
} from "@fungi.computer/parakeet/headless";
import type { McpApprovalSource } from "../src/button/mcp-approval-source.js";
import { AwaitingDecisionBox } from "../src/button/decision-box.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

/** What the conversation does with approvals: queue them and answer in the composer's place. */
export function ApprovalComposer({
  source,
  width,
  height,
}: Readonly<{
  source: McpApprovalSource | undefined;
  width: number;
  height: number;
}>) {
  const { colors } = useTerminalTheme("mocha");
  const store = useMemo(() => createParakeetInteractions(), []);
  useApprovalAwaiting({
    source,
    store,
    enabled: true,
    home: "/home/fixture",
    width: width - 2,
    noteLimit: MAX_APPROVAL_DENIAL_NOTE_LENGTH,
    onFailure: () => undefined,
  });
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const queue = awaitingQueue(state.awaiting.items, state.awaiting.later);
  return queue.current === undefined ? (
    <text>Ask anything… (draft)</text>
  ) : (
    <AwaitingDecisionBox
      key={queue.current.key}
      item={queue.current}
      position={queue.position}
      total={queue.total}
      onLater={() => {
        store.awaiting.later(queue.current?.key ?? "");
      }}
      colors={colors}
      surface={colors.surface}
      width={width - 2}
      rows={height}
      active
    />
  );
}
