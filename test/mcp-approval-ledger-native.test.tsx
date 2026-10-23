import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { act, useCallback, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { RpcStub, RpcTarget } from "@fungi.computer/capnweb";
import {
  ApprovalLedger,
  type ApprovalAnswerer,
  type Approvals,
  type ApprovalApplyHost,
} from "@fungi.computer/approvals";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  McpApprovalPrompt,
  loadMcpApprovalSource,
  type McpApprovalSource,
} from "../src/button/mcp-approval.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { pressDecodedKey } from "./native-readiness.js";

/** Real bound ledger methods behind the maintained native Agar RPC handle. */
class LedgerRpcHost extends RpcTarget {
  readonly reads: string[] = [];
  constructor(private readonly control: Approvals) {
    super();
  }
  get(input: Parameters<Approvals["get"]>[0]) {
    this.reads.push(input.recordId);
    return this.control.get(input);
  }
  answer(input: Parameters<Approvals["answer"]>[0]) {
    return this.control.answer(input);
  }
  list(input: Parameters<Approvals["list"]>[0]) {
    return this.control.list(input);
  }
  setAutoApprove(input: Parameters<Approvals["setAutoApprove"]>[0]) {
    return this.control.setAutoApprove(input);
  }
}

function View({ source }: Readonly<{ source: McpApprovalSource | undefined }>) {
  const { colors } = useTerminalTheme("mocha");
  const [open, setOpen] = useState(true);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  return source === undefined || !open ? null : (
    <McpApprovalPrompt source={source} colors={colors} onClose={close} />
  );
}

/** A manual-approval home using the owner's ordinary policy interface. */
function manualLedger(database: DatabaseSync, home: "team" | "oyster") {
  const ledger = new ApprovalLedger({
    owner: fromNodeSqlite(database),
    home: { kind: home, id: `${home}:renderer` },
    now: () => 100,
  });
  const member: ApprovalAnswerer = {
    kind: "human",
    memberId: "member:renderer",
    role: home === "oyster" ? "owner" : "member",
    actingForAgent: false,
    mayUseOperation: true,
  };
  if (home === "oyster") {
    // Oyster defaults to auto-approve; exercise an owner-selected manual
    // write family so the rendered approval can outlive membership.
    expect(
      ledger.setAutoApprove(
        {
          scope: { agentId: null },
          family: { module: null, access: "write" },
          enabled: false,
        },
        member,
      ),
    ).toMatchObject({ kind: "updated" });
  }
  return { ledger, member };
}

for (const { decision, revokeMembership } of [
  { decision: "approve", revokeMembership: false },
  { decision: "deny", revokeMembership: false },
  { decision: "approve", revokeMembership: true },
]) {
  const title = revokeMembership
    ? "a revoked member cannot answer a previously rendered genuine ledger record"
    : `a genuine ledger record loads through Agar and human ${decision} decides it`;
  test(title, async () => {
    const database = new DatabaseSync(":memory:");
    try {
      const { ledger, member } = manualLedger(
        database,
        revokeMembership ? "oyster" : "team",
      );
      let writes = 0;
      const applyHost: ApprovalApplyHost = {
        recheck: () =>
          Promise.resolve({
            kind: "authorized",
            authorityFence: "grant:renderer",
          }),
        dispatch: () => {
          writes++;
          return Promise.resolve({
            kind: "completed",
            output: { secret: "NEVER_RENDER_LEDGER_OUTPUT" },
          });
        },
      };
      const pending = await ledger.submit(
        {
          requester: {
            principalId: "agent:research",
            agentId: "research",
            sessionId: "session:research",
            displayName: "Research Agent",
          },
          module: "files",
          operation: "write",
          access: "write",
          reversibility: "reversible",
          authorityFence: "grant:renderer",
          idempotencyKey: "turn:renderer/tool:one",
          inputJson: '{"secret":"NEVER_RENDER_LEDGER_INPUT"}',
        },
        applyHost,
      );
      if (pending.kind !== "pending_approval")
        throw new Error("The real ledger did not produce a pending approval");
      let currentMember = true;
      const control = ledger.capability({
        actor: () => Promise.resolve(currentMember ? member : null),
        decision: async (recordId) => {
          await ledger.apply(recordId, applyHost);
        },
      });
      const host = new LedgerRpcHost(control);
      using remote = new RpcStub(host);
      const source = await loadMcpApprovalSource(remote, pending.recordId);
      expect(host.reads).toEqual([pending.recordId]);
      expect(
        await loadMcpApprovalSource(remote, "missing-record"),
      ).toBeUndefined();
      expect(writes).toBe(0);
      const setup = await testRender(<View source={source} />, {
        width: 100,
        height: 30,
      });
      try {
        await act(async () => setup.renderOnce());
        const frame = await setup.waitForFrame(
          (value) => value.includes("files.write") && value.includes("Approve"),
        );
        expect(frame).toContain("Research Agent");
        expect(frame).toContain("agent:research");
        expect(frame).toContain("session:research");
        expect(frame.replace(/\s/gu, "")).toContain(
          pending.description.inputSha256,
        );
        expect(frame).not.toContain("NEVER_RENDER_LEDGER_INPUT");
        expect(frame).not.toContain("NEVER_RENDER_LEDGER_OUTPUT");
        expect(writes).toBe(0);
        // Oyster re-resolves live membership for every answer. The displayed
        // snapshot can still be answerable when that membership disappears.
        if (revokeMembership) currentMember = false;
        await pressDecodedKey(setup, () => {
          if (decision === "deny") setup.mockInput.pressArrow("down");
          setup.mockInput.pressEnter();
        });
        if (revokeMembership) {
          await setup.waitForFrame((value) =>
            value.includes("Approval refused: not-eligible"),
          );
          expect(ledger.get(pending.recordId)).toMatchObject({
            state: "pending",
          });
          expect(control.get({ recordId: pending.recordId })).rejects.toThrow(
            "Approval read requires a current member",
          );
        } else {
          expect(
            await control.get({ recordId: pending.recordId }),
          ).toMatchObject({
            record: {
              state: decision === "approve" ? "applied" : "denied",
              by: { kind: "human", memberId: "member:renderer" },
            },
            canAnswer: false,
          });
        }
        expect(writes).toBe(
          decision === "approve" && !revokeMembership ? 1 : 0,
        );
        expect(setup.captureCharFrame()).not.toContain(
          "NEVER_RENDER_LEDGER_OUTPUT",
        );
      } finally {
        act(() => {
          setup.renderer.destroy();
        });
      }
    } finally {
      database.close();
    }
  });
}
