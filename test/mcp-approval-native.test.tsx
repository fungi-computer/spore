import { expect, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  McpApprovalPrompt,
  type McpApprovalSource,
} from "../src/button/mcp-approval.js";
import type { ApprovalView } from "@fungi.computer/approvals";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";
import { localExecEscapeReview } from "../../../runtimes/local/src/private-local-exec-review.js";
import { localExecRules } from "../../../runtimes/local/src/private-local-exec-rules.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function rulesFile(root: string): Promise<string> {
  try {
    return await readFile(join(root, ".fungi", "exec-rules.json"), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return "";
    throw cause;
  }
}

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

function fakeApprovals(respond?: McpApprovalSource["answer"]) {
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

function View({
  source,
  surface = false,
}: Readonly<{ source: McpApprovalSource; surface?: boolean }>) {
  const { colors } = useTerminalTheme("mocha");
  const [open, setOpen] = useState(true);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  const prompt = (
    <McpApprovalPrompt source={source} colors={colors} onClose={close} />
  );
  return !open ? null : surface ? (
    <DialogSurface colors={colors} onClose={close}>
      {prompt}
    </DialogSurface>
  ) : (
    prompt
  );
}

test("Deny and say why preserves Esc, treats blank as Deny, and sends a typed note", async () => {
  for (const input of ["escape", "empty", "note"] as const) {
    const producer = fakeApprovals();
    const setup = await testRender(<View source={producer.source} />, {
      width: 80,
      height: 30,
    });
    try {
      act(() => {
        producer.publish(approval());
      });
      const frame = await waitForFrame(setup, (value) =>
        value.includes("Deny and say why"),
      );
      expect(frame).toContain("Deny and say why");
      for (let index = 0; index < 2; index++)
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressArrow("down");
        });
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      expect(
        await waitForFrame(setup, (value) => value.includes("Why deny?")),
      ).toContain("Why deny?");
      const askingWhy = setup.captureCharFrame();
      expect(askingWhy.match(/Enter deny/gu)).toHaveLength(1);
      expect(askingWhy).toContain("Esc back");
      expect(askingWhy).not.toContain("Esc close");
      if (input === "escape") {
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressEscape();
        });
        expect(
          await waitForFrame(setup, (value) =>
            value.includes("Deny and say why"),
          ),
        ).toContain("Approve once");
        expect(producer.answers).toEqual([]);
      } else {
        if (input === "note")
          await act(async () => {
            await setup.mockInput.typeText("Use the sandbox instead");
          });
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressEnter();
        });
        const expected = {
          recordId: "approval-1",
          decision: "deny",
          expectedRevision: 7,
        } satisfies Parameters<McpApprovalSource["answer"]>[0];
        expect(producer.answers).toEqual([
          input === "note"
            ? { ...expected, denialNote: "Use the sandbox instead" }
            : expected,
        ]);
      }
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  }
});

test("typed rule coverage appears by Always allow; unavailable reason stays in Details", async () => {
  for (const available of [true, false]) {
    const producer = fakeApprovals();
    const source: McpApprovalSource = {
      ...producer.source,
      review: {
        form: "direct",
        kind: "exec",
        command: "git add hello.js",
        cwd: "/project",
        justification: "Stage changes",
        ...(available
          ? {
              prefix: ["git", "add"],
              alwaysAllowCoverage: "Any git add in this project",
            }
          : { alwaysAllowUnavailableReason: "This command cannot be reused." }),
      },
    };
    const setup = await testRender(<View source={source} />, {
      width: 120,
      height: 30,
    });
    try {
      act(() => {
        producer.publish(approval());
      });
      const frame = await waitForFrame(setup, (value) =>
        value.includes("Deny and say why"),
      );
      if (available) {
        expect(frame).toContain("Any git add in this project");
        expect(frame).toContain("Always allow");
      } else {
        expect(frame).not.toContain("Always allow");
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressKey("d");
        });
        expect(
          await waitForFrame(setup, (value) =>
            value.includes("This command cannot be reused."),
          ),
        ).toContain("This command cannot be reused.");
      }
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  }
});

test("Enter, Enter-Enter, and 2-Enter cannot persist an Always-allow rule", async () => {
  for (const keys of ["enter", "down-enter-enter", "2-enter", "2-down-enter"]) {
    const root = await mkdtemp(join(tmpdir(), "approval-card-rule-"));
    const producer = fakeApprovals();
    const source: McpApprovalSource = {
      ...producer.source,
      review: {
        form: "direct",
        kind: "exec",
        argv: ["git", "add", "hello.js"],
        command: "git add hello.js",
        cwd: root,
        justification: "Git metadata is read-only",
        prefix: ["git", "add"],
        risk: {
          summary:
            "Git hooks in this project can run code as you, and this Agent can add hooks.",
          detail:
            "Git runs hook scripts from the folder the project's hooksPath setting names.",
        },
      },
      answer: async (input) => {
        if (input.decision === "always-allow")
          localExecRules(root).add(["git", "add"]);
        return producer.source.answer(input);
      },
    };
    const setup = await testRender(<View source={source} />, {
      width: 80,
      height: 30,
    });
    try {
      act(() => {
        producer.publish(approval(keys));
      });
      const frame = await waitForFrame(setup, (value) =>
        value.includes("Approve once"),
      );
      expect(frame).toMatch(/▶ Approve once/u);
      for (const key of keys.split("-")) {
        await pressDecodedKey(setup, () => {
          if (key === "enter") setup.mockInput.pressEnter();
          else if (key === "down") setup.mockInput.pressArrow("down");
          else setup.mockInput.pressKey(key);
        });
      }
      expect(producer.answers.map((answer) => answer.decision)).toEqual(
        keys === "enter"
          ? ["approve"]
          : keys === "2-down-enter"
            ? ["always-allow"]
            : [],
      );
      const stored = await rulesFile(root);
      if (keys === "2-down-enter") expect(stored).toContain("git");
      else expect(stored).toBe("");
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("an immediate Enter cannot write the project grant file", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-card-immediate-"));
  const producer = fakeApprovals();
  const source: McpApprovalSource = {
    ...producer.source,
    review: {
      ...localExecEscapeReview(
        {
          executable: "git",
          args: ["add", "hello.js"],
          escape: { justification: "Needs Git" },
        },
        root,
      ),
    },
    answer: async (input) => {
      if (input.decision === "always-allow")
        localExecRules(root).add(["git", "add"]);
      return producer.source.answer(input);
    },
  };
  const setup = await testRender(<View source={source} />, {
    width: 80,
    height: 30,
  });
  try {
    act(() => {
      producer.publish(approval());
    });
    await waitForFrame(setup, (frame) => frame.includes("git add"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(await rulesFile(root)).toBe("");
    expect(producer.answers.map(({ decision }) => decision)).toEqual([
      "approve",
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    await rm(root, { recursive: true, force: true });
  }
});

async function card(
  review?: McpApprovalSource["review"],
  width = 80,
  view = approval(),
  respond?: McpApprovalSource["answer"],
  height = 30,
  surface = false,
) {
  const producer = fakeApprovals(respond);
  const source: McpApprovalSource =
    review === undefined ? producer.source : { ...producer.source, review };
  const setup = await testRender(<View source={source} surface={surface} />, {
    width,
    height,
  });
  act(() => {
    producer.publish(view);
  });
  await waitForFrame(setup, (frame) =>
    frame.includes(
      view.canAnswer ? "Approve once" : "Approved. Waiting to run.",
    ),
  );
  const press = async (key: string) => {
    await pressDecodedKey(setup, () => {
      if (key === "Enter") setup.mockInput.pressEnter();
      else if (key === "Esc") setup.mockInput.pressEscape();
      else if (key === "Down") setup.mockInput.pressArrow("down");
      else setup.mockInput.pressKey(key);
    });
  };
  return {
    setup,
    producer,
    press,
    frame: () => setup.captureCharFrame(),
    close: () => {
      act(() => {
        setup.renderer.destroy();
      });
    },
  };
}

const exec = (args: string[] = ["add", "hello.js"]) =>
  localExecEscapeReview(
    {
      executable: "git",
      args,
      escape: { justification: "Git metadata is read-only" },
    },
    "/project/fungi",
    { configuredRemotes: new Set<string>() },
  );

test("an unprotected Git approval keeps its hook risk on the main card and its rule reason in Details", async () => {
  const review = localExecEscapeReview(
    {
      executable: "git",
      args: ["commit", "-m", "approved"],
      escape: { justification: "Git metadata is read-only" },
    },
    "/project/fungi",
  );
  expect(review.prefix).toBeUndefined();
  const view = await card(review, 100);
  try {
    const main = view.frame();
    expect(main).toContain("Project hooks can run code as you");
    expect(main).toContain("Approve once");
    expect(main).toContain("Deny and say why");
    expect(main).not.toContain("Always allow");
    expect(main).not.toContain(
      "protected project Git repository is unavailable",
    );
    await view.press("d");
    const details = await waitForFrame(view.setup, (frame) =>
      frame.includes("protected project Git repository is unavailable"),
    );
    expect(details).toContain(
      "protected project Git repository is unavailable",
    );
    expect(details.match(/Project hooks can run code as you/gu)).toHaveLength(
      1,
    );
    expect(view.producer.answers).toEqual([]);
  } finally {
    view.close();
  }
});

test("an offered Git commit rule previews coverage, with the full host grammar in Details", async () => {
  const review = localExecEscapeReview(
    {
      executable: "git",
      args: ["commit", "-m", "approved"],
      escape: { justification: "Git metadata is read-only" },
    },
    "/project/fungi",
    { configuredRemotes: new Set<string>() },
  );
  expect(review.prefix).toEqual(["git", "commit"]);
  const view = await card(review, 120);
  try {
    expect(view.frame()).toContain("Direct argv git commit");
    expect(view.frame()).toContain(
      "Always allow “git commit” in this project…",
    );
    expect(view.frame()).not.toContain("-am VALUE");
    await view.press("d");
    const details = await waitForFrame(view.setup, (frame) =>
      frame.includes("-am VALUE"),
    );
    expect(details).toContain("-m VALUE");
    expect(details).toContain("Workspace Agents");
    await view.press("d");
    await view.press("2");
    const confirm = await waitForFrame(view.setup, (frame) =>
      frame.includes("Back"),
    );
    expect(confirm).toContain("Direct argv git commit");
    expect(confirm).toContain("Back");
    expect(view.producer.answers).toEqual([]);
  } finally {
    view.close();
  }
});

test("a replacement approval can answer only its current record and revision", async () => {
  const producer = fakeApprovals();
  const setup = await testRender(<View source={producer.source} />, {
    width: 80,
    height: 30,
  });
  try {
    act(() => {
      producer.publish(approval("old"));
    });
    await waitForFrame(setup, (frame) => frame.includes("Approve once"));
    act(() => {
      const next = approval("new", 8);
      producer.publish({
        ...next,
        record: { ...next.record, module: "notes", operation: "save" },
      });
    });
    await waitForFrame(setup, (frame) => frame.includes("Allow notes · save?"));
    expect(producer.answers).toEqual([]);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.answers).toEqual([
      { recordId: "new", decision: "approve", expectedRevision: 8 },
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a newer revision of the same approval replaces the answer fence", async () => {
  const producer = fakeApprovals();
  const setup = await testRender(<View source={producer.source} />, {
    width: 80,
    height: 30,
  });
  try {
    act(() => {
      producer.publish(approval());
    });
    await waitForFrame(setup, (frame) => frame.includes("Approve once"));
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

test("a Git escape presents command and reason but no internal identifiers on its main card", async () => {
  const view = await card(exec());
  try {
    const main = view.frame();
    expect(main).toContain("Allow `git add hello.js`?");
    expect(main).toContain("Folder");
    expect(main).toContain("Git metadata is read-only");
    for (const hidden of [
      "principal-1",
      "agent-1",
      "session-1",
      "SHA-256",
      "computer.exec",
      "Reversibility",
      "approval-1",
      "bytes",
    ])
      expect(main).not.toContain(hidden);
    await view.press("d");
    const details = await waitForFrame(view.setup, (frame) =>
      frame.includes("principal-1"),
    );
    // ModalDetails scrolls long host disclosures; verify the lower metadata is
    // reachable rather than requiring every row to fit at once.
    const visible = [details];
    for (
      let scrolls = 0;
      scrolls < 30 && !visible.join("\n").includes("SHA-256");
      scrolls++
    ) {
      await view.press("Down");
      visible.push(view.frame());
    }
    const scrolledDetails = visible.join("\n");
    for (const found of [
      "principal-1",
      "agent-1",
      "session-1",
      "SHA-256",
      "computer.exec",
      "approval-1",
      "bytes",
    ])
      expect(scrolledDetails).toContain(found);
    await view.press("d");
    expect(view.frame()).toContain("Approve once");
  } finally {
    view.close();
  }
});

for (const sub of [
  "add",
  "branch",
  "checkout",
  "commit",
  "diff",
  "fetch",
  "merge",
  "pull",
  "push",
  "reset",
  "restore",
  "stash",
  "status",
  "switch",
  "tag",
]) {
  test(`git ${sub} shows its hook warning once, only when confirming`, async () => {
    const view = await card(exec([sub]));
    try {
      expect(view.frame()).not.toContain(
        "Git hooks in this project can run code as you",
      );
      await view.press("2");
      const confirm = await waitForFrame(view.setup, (frame) =>
        frame.includes("Git hooks in this project can run code as you"),
      );
      expect(
        confirm.match(/Git hooks in this project can run code as you/gu),
      ).toHaveLength(1);
      expect(confirm).toContain("Back");
      expect(view.producer.answers).toEqual([]);
      await view.press("Esc");
      expect(view.frame()).toContain("Approve once");
    } finally {
      view.close();
    }
  });
}

for (const height of [24, 26, 22]) {
  test(`80x${String(height)} confirmation keeps both choices and the Git risk legible`, async () => {
    const view = await card(exec(), 80, approval(), undefined, height, true);
    try {
      const main = view.frame();
      expect(main).toContain("Always allow “git add” in this project…");
      expect(main).not.toContain("Only these options are reusable");
      expect(main).not.toContain("● Approval");
      expect(main.match(/Enter select/gu)).toHaveLength(1);
      await view.press("2");
      const frame = await waitForFrame(view.setup, (value) =>
        value.includes("Back"),
      );
      const visible = frame
        .split("\n")
        .map((line) => line.trim())
        .join(" ")
        .replace(/\s+/gu, " ");
      expect(visible).toContain("Always allow “git add” in this project?");
      expect(visible).toContain(
        "Git hooks in this project can run code as you, and this Agent can add hooks.",
      );
      expect(frame).toContain("Always allow “git add” and run it now");
      expect(frame).toMatch(/▶ Back/u);
      // Modal-c confirmation carries only the warning and bounded coverage,
      // not the main card's Folder, Why or Scope fact rows.
      expect(frame).not.toMatch(/^\s*(?:Folder|Why|Scope)\s{2,}/mu);
      expect(frame).not.toContain("● Approval");
      expect(frame.match(/Enter select/gu)).toHaveLength(1);
      expect(view.producer.answers).toEqual([]);
    } finally {
      view.close();
    }
  });
}

for (const [width, height] of [
  [80, 22],
  [80, 24],
  [80, 26],
  [80, 13],
  [80, 30],
  [120, 30],
] as const) {
  test(`${String(width)}x${String(height)} git push confirmation shows hooks, push and remote risks before a reusable grant`, async () => {
    const view = await card(
      exec(["push"]),
      width,
      approval(),
      undefined,
      height,
      true,
    );
    try {
      await view.press("2");
      const frame = await waitForFrame(view.setup, (value) =>
        value.includes("Back"),
      );
      const visible = frame
        .split("\n")
        .map((line) => line.trim())
        .join(" ")
        .replace(/\s+/gu, " ");
      expect(visible).toContain("Always allow “git push” in this project?");
      expect(visible).toContain(
        "Git hooks in this project can run code as you, and this Agent can add hooks.",
      );
      expect(visible).toContain(
        "It can push, force-push or delete any branch.",
      );
      expect(visible).toContain("Remotes can use your SSH keys.");
      expect(visible).toContain("Direct argv git push");
      expect(
        frame.match(/Git hooks in this project can run code as you/gu),
      ).toHaveLength(1);
      expect(frame).toMatch(/▶ Back/u);
      expect(frame).toContain("Always allow “git push” and run it now");
      expect(view.producer.answers).toEqual([]);
    } finally {
      view.close();
    }
  });
}

test("Deny is directly selectable and never creates a rule", async () => {
  const view = await card(exec());
  try {
    await view.press("3");
    expect(view.producer.answers.map(({ decision }) => decision)).toEqual([
      "deny",
    ]);
  } finally {
    view.close();
  }
});

test("Details returns to the previously highlighted choice without answering", async () => {
  const view = await card(exec());
  try {
    await view.press("Down");
    expect(view.frame()).toMatch(/▶ Always allow/u);
    await view.press("d");
    expect(view.frame()).toContain("Details");
    await view.press("d");
    expect(view.frame()).toMatch(/▶ Always allow/u);
    expect(view.producer.answers).toEqual([]);
  } finally {
    view.close();
  }
});

test("MCP tool has no Always-allow and discloses an irreversible external effect", async () => {
  const record = approval();
  const view = await card(undefined, 80, {
    ...record,
    record: { ...record.record, module: "linear", operation: "create_issue" },
  });
  try {
    expect(view.frame()).toContain("Allow linear · create_issue?");
    expect(view.frame()).toContain(
      "Changes things outside Fungi · can't be undone",
    );
    expect(view.frame()).not.toContain("Always allow");
    await view.press("2");
    expect(view.producer.answers.map(({ decision }) => decision)).toEqual([
      "deny",
    ]);
  } finally {
    view.close();
  }
});

test("shell and extension install never offer Always-allow; extension discloses its authority", async () => {
  for (const review of [
    localExecEscapeReview(
      { command: "echo hello", escape: { justification: "Needs access" } },
      "/project/fungi",
    ),
    localExecEscapeReview(
      {
        executable: "fungi",
        args: ["extension", "add", "./tools/linter"],
        escape: { justification: "Installing the project's linter extension." },
      },
      "/project/fungi",
    ),
  ]) {
    const view = await card(review);
    try {
      expect(view.frame()).toContain("Approve once");
      expect(view.frame()).toContain("Deny");
      expect(view.frame()).not.toContain("Always allow");
      if (review.kind === "extension-install")
        expect(view.frame()).toContain(
          "Extensions run inside Fungi with access to every Agent.",
        );
    } finally {
      view.close();
    }
  }
});

test("Esc closes without denying a still-pending request", async () => {
  const view = await card(exec());
  try {
    await view.press("Esc");
    expect(view.producer.answers).toEqual([]);
    expect(view.producer.source.snapshot()?.record.state).toBe("pending");
  } finally {
    view.close();
  }
});

test("read-only state has no answer picker", async () => {
  const record = approval();
  const view = await card(exec(), 80, {
    ...record,
    record: { ...record.record, state: "approved" },
    canAnswer: false,
  });
  try {
    expect(view.frame()).toContain("Approved. Waiting to run.");
    expect(view.frame()).not.toContain("Approve once");
  } finally {
    view.close();
  }
});

test("a stale revision refusal remains visible, not approval success", async () => {
  const view = await card(undefined, 80, approval(), () =>
    Promise.resolve({ kind: "refused", reason: "stale-revision" }),
  );
  try {
    await view.press("Enter");
    expect(
      await waitForFrame(view.setup, (frame) =>
        frame.includes("This request changed. Look again before answering."),
      ),
    ).not.toContain("Done.");
    expect(view.producer.source.snapshot()?.record.state).toBe("pending");
  } finally {
    view.close();
  }
});

test("eligibility refusal distinguishes a denied rule from lost answer rights", async () => {
  for (const [always, expected] of [
    [false, "Couldn't answer (not-eligible). Nothing ran."],
    [
      true,
      "Always allow isn't available for this command. Approve once or deny.",
    ],
  ] as const) {
    const view = await card(exec(), 80, approval(), () =>
      Promise.resolve({ kind: "refused", reason: "not-eligible" }),
    );
    try {
      if (always) {
        await view.press("Down");
        await view.press("Enter");
        await view.press("Down");
      }
      await view.press("Enter");
      await waitForFrame(view.setup, (frame) =>
        frame.includes(expected.slice(0, 24)),
      );
      expect(view.producer.source.snapshot()?.record.state).toBe("pending");
    } finally {
      view.close();
    }
  }
});

for (const width of [80, 60]) {
  test(`the ${String(width)}-column escape keeps Approve once highlighted within the surface`, async () => {
    const view = await card(
      exec(["commit", "-m", "a very long message with words and spaces"]),
      width,
    );
    try {
      expect(view.frame()).toMatch(/▶ Approve once/u);
      for (const line of view.frame().split("\n"))
        expect(line.length).toBeLessThanOrEqual(width);
    } finally {
      view.close();
    }
  });
}
