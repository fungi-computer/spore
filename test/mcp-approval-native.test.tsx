import { expect, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createRoot } from "@opentui/react";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { openTerminalApplication } from "../src/terminal-application.js";
import { renderTuiConversation } from "../src/frame-renderer.js";
import { createTuiFixture } from "./fixture.js";
import {
  McpApprovalPrompt,
  type McpApprovalSource,
} from "../src/button/mcp-approval.js";
import type { ApprovalView, Approvals } from "@fungi.computer/approvals";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

function approval(recordId = "approval-1", revision = 7): ApprovalView {
  return {
    record: {
      recordId,
      revision,
      requester: {
        principalId: "principal-1",
        agentId: "agent-1",
        sessionId: "session-1",
        displayName: "Research Agent",
      },
      module: "files",
      operation: "write",
      access: "write",
      description: {
        title: "Allow files.write (write)?",
        inputBytes: 4321,
        inputSha256: "0123456789abcdef".repeat(4),
      },
      authorityFence: "fixture-authority",
      reversibility: "irreversible-external",
      state: "pending",
      by: null,
      reason: null,
      requestedAt: 100,
      expiresAt: 1000,
      updatedAt: 100,
    },
    canAnswer: true,
    canSetAutoApprove: false,
  };
}

function fakeApprovals(respond?: Approvals["answer"]) {
  let pending: ApprovalView | undefined;
  const listeners = new Set<() => void>();
  const answers: Parameters<Approvals["answer"]>[0][] = [];
  const source: McpApprovalSource = {
    snapshot: () => pending,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    answer: async (input) => {
      answers.push(input);
      if (respond !== undefined) return respond(input);
      const view = pending;
      if (view?.record.recordId === input.recordId) {
        pending = undefined;
        for (const listener of listeners) listener();
        return {
          kind: "answered",
          view: {
            ...view,
            canAnswer: false,
            record: {
              ...view.record,
              state: input.decision === "approve" ? "approved" : "denied",
              revision: view.record.revision + 1,
              by: { kind: "human", memberId: "fixture-member" },
            },
          },
        };
      }
      return { kind: "refused", reason: "not-found" };
    },
  };
  return {
    source,
    answers,
    publish: (next: ApprovalView) => {
      pending = next;
      for (const listener of listeners) listener();
    },
  };
}

function View({ source }: Readonly<{ source: McpApprovalSource }>) {
  const { colors } = useTerminalTheme("mocha");
  const [open, setOpen] = useState(true);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  return open ? (
    <McpApprovalPrompt source={source} colors={colors} onClose={close} />
  ) : null;
}

test("a replacement approval cannot answer the preceding request", async () => {
  const producer = fakeApprovals();
  const setup = await testRender(<View source={producer.source} />, {
    width: 80,
    height: 24,
  });
  try {
    act(() => {
      producer.publish(approval("old"));
    });
    await waitForFrame(setup, (frame) => frame.includes("Allow files.write"));
    act(() => {
      const next = approval("new");
      producer.publish({
        ...next,
        record: {
          ...next.record,
          description: {
            ...next.record.description,
            title: "Allow notes.save (write)?",
          },
        },
      });
    });
    await waitForFrame(setup, (frame) => frame.includes("Allow notes.save"));
    expect(producer.answers).toEqual([]);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.answers).toEqual([
      { recordId: "new", decision: "approve", expectedRevision: 7 },
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const decision of ["approve", "deny"] as const) {
  test(`approval metadata is visible and ${decision} names the displayed record revision`, async () => {
    const producer = fakeApprovals();
    const setup = await testRender(<View source={producer.source} />, {
      width: 80,
      height: 24,
    });
    try {
      await act(async () => {
        producer.publish(approval());
        await setup.renderOnce();
      });
      const metadata = await waitForFrame(
        setup,
        (frame) =>
          frame.includes("Waiting for approval") &&
          frame.includes("Allow files.write (write)?") &&
          frame.includes("Approve") &&
          frame.includes("Deny"),
      );
      expect(metadata).toContain("Research Agent");
      expect(metadata).toContain("principal-1");
      expect(metadata).toContain("agent-1");
      expect(metadata).toContain("session-1");
      expect(metadata).toContain("files.write");
      expect(metadata).toContain("irreversible-external");
      expect(metadata).toContain("4321 bytes");
      expect(metadata.replace(/\s/gu, "")).toContain(
        approval().record.description.inputSha256,
      );
      expect(producer.answers).toEqual([]);
      await pressDecodedKey(setup, () => {
        if (decision === "deny") setup.mockInput.pressArrow("down");
        setup.mockInput.pressEnter();
      });
      expect(producer.answers).toEqual([
        { recordId: "approval-1", decision, expectedRevision: 7 },
      ]);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}

test("host-recomputed rights remove the answer controls", async () => {
  const producer = fakeApprovals();
  const setup = await testRender(<View source={producer.source} />, {
    width: 80,
    height: 24,
  });
  try {
    act(() => {
      producer.publish(approval());
    });
    await waitForFrame(setup, (frame) => frame.includes("Approve"));
    act(() => {
      producer.publish({ ...approval(), canAnswer: false });
    });
    const frame = await waitForFrame(setup, (frame) =>
      frame.includes("read-only"),
    );
    expect(frame).not.toContain("Approve");
    expect(frame).not.toContain("Deny");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.answers).toEqual([]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a new revision of the same record replaces the displayed answer fence", async () => {
  const producer = fakeApprovals();
  const setup = await testRender(<View source={producer.source} />, {
    width: 80,
    height: 24,
  });
  try {
    act(() => {
      producer.publish(approval());
    });
    await waitForFrame(setup, (frame) => frame.includes("Approve"));
    act(() => {
      producer.publish(approval("approval-1", 8));
    });
    await act(async () => setup.renderOnce());
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.answers).toEqual([
      { recordId: "approval-1", decision: "approve", expectedRevision: 8 },
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a typed stale-revision refusal remains visible and is not approval success", async () => {
  const producer = fakeApprovals(() =>
    Promise.resolve({
      kind: "refused",
      reason: "stale-revision",
    }),
  );
  const setup = await testRender(<View source={producer.source} />, {
    width: 80,
    height: 24,
  });
  try {
    act(() => {
      producer.publish(approval());
    });
    await waitForFrame(setup, (frame) => frame.includes("Approve"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    const frame = await waitForFrame(setup, (frame) =>
      frame.includes("Approval refused: stale-revision"),
    );
    expect(frame).not.toContain("Waiting for approval");
    expect(producer.source.snapshot()?.record.state).toBe("pending");
    expect(producer.answers).toEqual([
      { recordId: "approval-1", decision: "approve", expectedRevision: 7 },
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const decision of ["approve", "dismiss"] as const) {
  test(`the conversation routes an ApprovalView through its existing dialog: ${decision}`, async () => {
    const producer = fakeApprovals();
    const setup = await testRender(<box />, { width: 80, height: 24 });
    const app = await openTerminalApplication({
      signals: { on: () => undefined, off: () => undefined },
      createQueryClient,
      createRenderer: () => Promise.resolve(setup.renderer),
      createRoot,
      createWhistle,
      enableKeymap: true,
    });
    if (app === undefined) throw new Error("Terminal did not open");
    app.inputHandoff?.pause();
    try {
      act(() => {
        renderTuiConversation(app.root, app.queryClient, {
          session: createTuiFixture().session,
          commands: app.commands,
          commandHost: app.commandHost,
          mcpApprovals: producer.source,
        });
      });
      await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
      act(() => {
        producer.publish(approval("conversation-approval"));
      });
      await waitForFrame(
        setup,
        (frame) =>
          frame.includes("Waiting for approval") &&
          frame.includes("Allow files.write (write)?"),
      );
      expect(producer.answers).toEqual([]);
      await pressDecodedKey(setup, () => {
        if (decision === "dismiss") setup.mockInput.pressEscape();
        else setup.mockInput.pressEnter();
      });
      expect(producer.answers).toEqual(
        decision === "dismiss"
          ? []
          : [
              {
                recordId: "conversation-approval",
                decision: "approve",
                expectedRevision: 7,
              },
            ],
      );
      if (decision === "dismiss")
        expect(producer.source.snapshot()?.record.state).toBe("pending");
      await waitForFrame(
        setup,
        (frame) =>
          frame.includes("Ask anything") &&
          !frame.includes("Waiting for approval"),
      );
    } finally {
      await act(async () => app.close());
    }
  });
}
