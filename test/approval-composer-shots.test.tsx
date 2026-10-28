import { test } from "bun:test";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import type { McpApprovalSource } from "../src/button/mcp-approval-source.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { transcript } from "./composer-question-fixture.js";
import { captureFrame } from "./frame-capture.js";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

const output = process.env.TUI_COMPOSER_Q_SHOTS;

const view = {
  record: {
    recordId: "approval-1",
    revision: 7,
    requester: {
      principalId: "principal-1",
      agentId: "agent-1",
      sessionId: "session-1",
      displayName: "Research Agent",
    },
    module: "computer",
    operation: "exec",
    access: "external" as const,
    description: {
      title: "Allow computer.exec (external)?",
      inputBytes: 4321,
      inputSha256: "0123456789abcdef".repeat(4),
    },
    authorityFence: "fixture-authority",
    reversibility: "irreversible-external" as const,
    state: "pending" as const,
    by: null,
    reason: null,
    requestedAt: 100,
    expiresAt: Date.now() + 3_600_000,
    updatedAt: 100,
  },
  canAnswer: true,
  canSetAutoApprove: false,
};

// Screenshot capture for review; it asserts nothing the product tests do not.
for (const theme of ["latte", "mocha"] as const)
  for (const [width, height] of [
    [120, 36],
    [60, 24],
  ] as const)
    test.skipIf(output === undefined)(
      `captures the composer approval states at ${String(width)}x${String(height)} in ${theme}`,
      async () => {
        notifyManager.setScheduler(queueMicrotask);
        const fixture = createTuiFixture({ messages: transcript });
        let refuse = false;
        const source: McpApprovalSource = {
          snapshot: () => view,
          subscribe: () => () => undefined,
          review: {
            form: "direct",
            kind: "exec",
            argv: ["git", "add", "hello.js"],
            command: "git add hello.js",
            cwd: "/home/levi/src/garden",
            justification: "Stage the changes for the next commit",
            prefix: ["git", "add"],
            alwaysAllowCoverage:
              "Direct argv git add for Workspace Agents in this project.",
            risk: {
              summary:
                "Git hooks in this project can run code as you, and this Agent can add hooks.",
              detail: "Git runs hook scripts from the hooksPath folder.",
            },
          },
          answer: () =>
            Promise.resolve(
              refuse
                ? { kind: "refused", reason: "stale-revision" }
                : { kind: "refused", reason: "not-found" },
            ),
        };
        const commands = createWhistle();
        const query = createQueryClient();
        const setup = await testRender(
          <QueryClientProvider client={query}>
            <TuiFrame
              initialTheme={theme}
              session={fixture.session}
              commands={commands}
              mcpApprovals={source}
            />
          </QueryClientProvider>,
          { width, height, kittyKeyboard: true },
        );
        const shot = async (state: string) => {
          if (output === undefined) return;
          await mkdir(output, { recursive: true });
          await captureFrame(
            setup,
            output,
            `after-${String(width)}-${theme}-${state}`,
          );
        };
        const press = async (key: string) => {
          await pressDecodedKey(setup, () => {
            if (key === "Enter") setup.mockInput.pressEnter();
            else if (key === "Down") setup.mockInput.pressArrow("down");
            else setup.mockInput.pressKey(key);
          });
        };
        try {
          await act(async () => setup.renderOnce());
          await waitForFrame(setup, (frame) => frame.includes("Approve once"));
          await shot("approval");
          await press("2");
          await press("Enter");
          await waitForFrame(setup, (frame) => frame.includes("Back"));
          await shot("approval-confirm");
          await pressDecodedKey(setup, () => {
            setup.mockInput.pressEscape();
          });
          await waitForFrame(setup, (frame) => frame.includes("Approve once"));
          refuse = true;
          await press("Enter");
          await waitForFrame(setup, (frame) =>
            frame.includes("This request changed"),
          );
          await shot("approval-refused");
        } finally {
          await destroyTestRenderer(setup, () => {
            commands.close();
            query.clear();
          });
          await fixture.waitForClose();
          notifyManager.setScheduler(defaultScheduler);
        }
      },
    );
