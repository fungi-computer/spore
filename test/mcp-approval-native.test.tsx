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
import { localExecEscapeReview } from "../../../runtimes/local/src/private-local-exec-review.js";

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
      module: "computer",
      operation: "exec",
      access: "external",
      description: {
        title: "Allow computer.exec (external)?",
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
  const answers: Parameters<McpApprovalSource["answer"]>[0][] = [];
  const source: McpApprovalSource = {
    snapshot: () => pending,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    answer: async (input) => {
      answers.push(input);
      if (
        respond !== undefined &&
        (input.decision === "approve" || input.decision === "deny")
      )
        return respond({ ...input, decision: input.decision });
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
              state: input.decision === "deny" ? "denied" : "approved",
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

test("escape card shows the exact command and cwd before a human answers", async () => {
  const producer = fakeApprovals();
  const source: McpApprovalSource = {
    ...producer.source,
    review: {
      command: 'git commit -m "approved"',
      cwd: "/project/fungi",
      justification: "Git metadata is read-only",
    },
  };
  const setup = await testRender(<View source={source} />, {
    width: 100,
    height: 30,
  });
  try {
    act(() => {
      producer.publish(approval("escaped-command"));
    });
    const frame = await waitForFrame(
      setup,
      (value) =>
        value.includes("git commit") &&
        value.includes("Approve") &&
        value.includes("Deny"),
    );
    expect(frame).toContain("/project/fungi");
    expect(frame).toContain("Git metadata is read-only");
    expect(producer.answers).toHaveLength(0);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("the attached human chooses a narrow Git subcommand after seeing the outside-sandbox warning", async () => {
  const producer = fakeApprovals();
  const source: McpApprovalSource = {
    ...producer.source,
    review: {
      command: '["git","push","-u","origin","b"]',
      cwd: "/project/fungi",
      justification: "Git metadata is read-only",
      prefix: ["git"],
      warning:
        "Any git command in this project runs as you, outside the sandbox.",
    },
  };
  const setup = await testRender(<View source={source} />, {
    width: 100,
    height: 30,
  });
  try {
    act(() => {
      producer.publish(approval("project-git"));
    });
    const frame = await waitForFrame(setup, (value) =>
      value.includes("Always allow git"),
    );
    expect(frame).toContain("outside the sandbox");
    expect(producer.answers).toHaveLength(0);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.answers).toEqual([
      {
        recordId: "project-git",
        decision: "always-allow",
        expectedRevision: 7,
      },
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const subcommand of ["commit", "push", "merge", "diff"]) {
  test(`the git ${subcommand} card shows the hook-execution warning before an answer`, async () => {
    const producer = fakeApprovals();
    const review = localExecEscapeReview(
      {
        executable: "git",
        args: [subcommand],
        escape: { justification: "Git metadata is read-only" },
      },
      "/project/fungi",
    );
    const source: McpApprovalSource = {
      ...producer.source,
      review,
    };
    const setup = await testRender(<View source={source} />, {
      width: 88,
      height: 36,
    });
    try {
      act(() => {
        producer.publish(approval(`project-${subcommand}`));
      });
      const frame = await waitForFrame(setup, (value) =>
        value.includes("run code as you"),
      );
      expect(frame).toContain(`Always allow git ${subcommand}:`);
      expect(frame).toContain("create missing hook files");
      expect(frame.replace(/\s+/gu, " ")).toContain(
        "Only the hooksPath setting must pre-exist",
      );
      expect(frame).not.toContain(
        `Always allow git ${subcommand}: Always allow git ${subcommand}`,
      );
      if (subcommand === "push")
        expect(frame).toContain("delete remote branches");
      expect(producer.answers).toEqual([]);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}

test("a git push card can choose its project subcommand prefix", async () => {
  const producer = fakeApprovals();
  const source: McpApprovalSource = {
    ...producer.source,
    review: {
      command: '["git","push","-u","origin","b"]',
      cwd: "/project/fungi",
      justification: "Git metadata is read-only",
      prefix: ["git", "push"],
      warning:
        "Any git push command in this project runs as you, outside the sandbox.",
    },
  };
  const setup = await testRender(<View source={source} />, {
    width: 100,
    height: 30,
  });
  try {
    act(() => {
      producer.publish(approval("project-push"));
    });
    const frame = await waitForFrame(setup, (value) =>
      value.includes("Always allow git push"),
    );
    expect(frame).not.toContain("Always allow git:");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.answers).toEqual([
      {
        recordId: "project-push",
        decision: "always-allow",
        expectedRevision: 7,
      },
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a git push card offers only a narrow rule or one-time approval", async () => {
  const producer = fakeApprovals();
  const source: McpApprovalSource = {
    ...producer.source,
    review: {
      command: '["git","push","-u","origin","b"]',
      cwd: "/project/fungi",
      justification: "Git metadata is read-only",
      prefix: ["git", "push"],
    },
  };
  const setup = await testRender(<View source={source} />, {
    width: 100,
    height: 30,
  });
  try {
    act(() => {
      producer.publish(approval("narrow-git"));
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Always allow git push"),
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, (frame) => frame.includes("1 ▶ Approve"));

    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.answers).toEqual([
      {
        recordId: "narrow-git",
        decision: "approve",
        expectedRevision: 7,
      },
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

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
    await waitForFrame(setup, (frame) => frame.includes("Allow computer.exec"));
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
          frame.includes("Allow computer.exec (external)?") &&
          frame.includes("Approve") &&
          frame.includes("Deny"),
      );
      expect(metadata).toContain("Research Agent");
      expect(metadata).toContain("principal-1");
      expect(metadata).toContain("agent-1");
      expect(metadata).toContain("session-1");
      expect(metadata).toContain("computer.exec");
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
          frame.includes("Allow computer.exec (external)?"),
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
