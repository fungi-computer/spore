import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createRoot } from "@opentui/react";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import {
  mcpFormApprovalContract,
  type McpFormAnswerResult,
} from "@fungi.computer/truffle";
import type { SessionExtensionSlots } from "@fungi.computer/shiitake/client";
import type { ParakeetSession } from "@fungi.computer/parakeet/headless";
import type { Json } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import { openTerminalApplication } from "../src/terminal-application.js";
import { renderTuiConversation } from "../src/frame-renderer.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

type Pending = typeof mcpFormApprovalContract.projection.schema.Type.pending;
const encodeProjection = Schema.encodeSync(
  mcpFormApprovalContract.projection.schema,
);
const decodeAnswer = Schema.decodeUnknownSync(
  mcpFormApprovalContract.commands.answer.input,
);
type Answer = typeof mcpFormApprovalContract.commands.answer.input.Type;
type Respond = (input: Answer) => Promise<McpFormAnswerResult>;

function form(
  id: string,
  title = "Allow computer.exec (external)?",
  revision = 7,
): Pending[number] {
  return {
    id,
    approval: {
      record: {
        recordId: `record-${id}`,
        revision,
        requester: {
          principalId: "principal-1",
          agentId: "agent-1",
          sessionId: "session-1",
          displayName: "Research Agent",
        },
        module: "computer",
        operation: title === "Allow computer.exec (external)?" ? "exec" : title,
        access: "external",
        description: {
          title,
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
    },
  };
}

/** Faithful Session projection/command seam, not an attachment-authority fake. */
async function formSession(respond?: Respond) {
  const fixture = createTuiFixture();
  const snapshot = await fixture.session.read();
  let pending: Pending = [];
  const calls: { extensionId: string; name: string; input: Json }[] = [];
  const extensions = (): SessionExtensionSlots => ({
    ...snapshot.extensions,
    [mcpFormApprovalContract.id]: {
      status: "running",
      revision: "sha256:form-fixture",
      value: encodeProjection({ pending }),
    },
  });
  const publish = (next: Pending) => {
    pending = next;
    fixture.pushFrame({
      kind: "update",
      delivery: "live",
      cursor: snapshot.cursor,
      messages: [],
      terminals: [],
      activity: snapshot.activity,
      attention: snapshot.attention,
      extensions: extensions(),
      pending: snapshot.pending,
    });
  };
  const session: ParakeetSession = {
    ...fixture.session,
    read: async () => ({
      ...(await fixture.session.read()),
      extensions: extensions(),
    }),
    watch: async () => {
      const watch = await fixture.session.watch();
      return {
        ...watch,
        snapshot: { ...watch.snapshot, extensions: extensions() },
      };
    },
    extension: (extensionId) =>
      extensionId !== mcpFormApprovalContract.id
        ? fixture.session.extension(extensionId)
        : {
            call: async (name, input) => {
              calls.push({ extensionId, name, input });
              if (name !== "answer") throw new Error("Unexpected form command");
              const answer = decodeAnswer(input);
              if (!pending.some((entry) => entry.id === answer.id))
                return { kind: "refused", reason: "not-pending" };
              const selected = pending.find((entry) => entry.id === answer.id);
              if (selected === undefined)
                throw new Error("Pending fixture disappeared");
              const result: McpFormAnswerResult =
                respond === undefined
                  ? { kind: "answered", view: selected.approval }
                  : await respond(answer);
              if (result.kind === "answered")
                publish(pending.filter((entry) => entry.id !== answer.id));
              return result;
            },
          },
  };
  return { session, publish, calls, fixture };
}

async function mount(respond?: Respond) {
  const producer = await formSession(respond);
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
  act(() => {
    renderTuiConversation(app.root, app.queryClient, {
      session: producer.session,
      commands: app.commands,
      commandHost: app.commandHost,
    });
  });
  await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
  return {
    producer,
    setup,
    close: async () => {
      await act(async () => app.close());
    },
  };
}

test("a watched canonical approval displays ledger facts and answers with its revision", async () => {
  const { producer, setup, close } = await mount();
  try {
    act(() => {
      producer.publish([form("host-minted-1")]);
    });
    await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Allow computer · exec?") &&
        frame.includes("Approve") &&
        frame.includes("Deny"),
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Research Agent");
    expect(frame).not.toContain("4321 bytes");
    expect(frame).not.toContain("SHA-256");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("d");
    });
    const details = await waitForFrame(setup, (value) =>
      value.includes("SHA-256"),
    );
    expect(details).toContain("4,321 bytes");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("d");
    });
    expect(producer.calls).toEqual([]);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.calls).toEqual([
      {
        extensionId: "botanical-local-mcp-form",
        name: "answer",
        input: {
          id: "host-minted-1",
          decision: "approve",
          expectedRevision: 7,
        },
      },
    ]);
    expect(producer.fixture.watchCalls()).toBe(1);
    expect(producer.fixture.abortCalls()).toBe(0);
    expect(producer.fixture.cancelCalls()).toEqual([]);
  } finally {
    await close();
  }
});

for (const action of ["deny", "escape"]) {
  test(`a watched approval ${action === "deny" ? "sends deny" : "dismisses without answering"} for human ${action}`, async () => {
    const { producer, setup, close } = await mount();
    try {
      act(() => {
        producer.publish([form("host-minted-2")]);
      });
      await waitForFrame(setup, (frame) =>
        frame.includes("Allow computer · exec?"),
      );
      if (action === "deny")
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressArrow("down");
        });
      await pressDecodedKey(setup, () => {
        if (action === "deny") setup.mockInput.pressEnter();
        else setup.mockInput.pressEscape();
      });
      expect(producer.calls).toEqual(
        action === "escape"
          ? []
          : [
              {
                extensionId: "botanical-local-mcp-form",
                name: "answer",
                input: {
                  id: "host-minted-2",
                  decision: "deny",
                  expectedRevision: 7,
                },
              },
            ],
      );
      expect(producer.fixture.abortCalls()).toBe(0);
      expect(producer.fixture.cancelCalls()).toEqual([]);
    } finally {
      await close();
    }
  });
}

for (const reason of ["not-attached", "not-pending"] as const) {
  test(`a ${reason} refusal is visible, not approval success`, async () => {
    const { producer, setup, close } = await mount(() =>
      Promise.resolve({ kind: "refused", reason }),
    );
    try {
      act(() => {
        producer.publish([form("refused-form")]);
      });
      await waitForFrame(setup, (frame) =>
        frame.includes("Allow computer · exec?"),
      );
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      const frame = await waitForFrame(setup, (frame) =>
        frame.includes(`Couldn't answer (${reason}). Nothing ran.`),
      );
      expect(frame).not.toContain("approved successfully");
      expect(producer.calls).toHaveLength(1);
      expect(producer.calls[0]?.input).toEqual({
        id: "refused-form",
        decision: "approve",
        expectedRevision: 7,
      });
    } finally {
      await close();
    }
  });
}

test("Esc steps back once from the Deny line, then postpones, through the terminal's own keymap", async () => {
  const { producer, setup, close } = await mount();
  try {
    act(() => {
      producer.publish([form("two-escapes")]);
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Allow computer · exec?"),
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    await waitForFrame(setup, (frame) => frame.includes("Esc back"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEscape();
    });
    // One Esc is one step: back to the options, still asking.
    const back = await waitForFrame(setup, (frame) =>
      frame.includes("Esc later"),
    );
    expect(back).toContain("Approve once");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEscape();
    });
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
    expect(producer.calls).toEqual([]);
    expect(producer.fixture.cancelCalls()).toEqual([]);
  } finally {
    await close();
  }
});

test("a withdrawn form closes without a redundant or stale answer command", async () => {
  const { producer, setup, close } = await mount();
  try {
    act(() => {
      producer.publish([form("withdrawn")]);
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Allow computer · exec?"),
    );
    act(() => {
      producer.publish([]);
    });
    await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Ask anything") &&
        !frame.includes("Allow computer · exec?"),
    );
    expect(producer.calls).toEqual([]);
  } finally {
    await close();
  }
});

test("a replaced pending id cannot answer its successor", async () => {
  const { producer, setup, close } = await mount();
  try {
    act(() => {
      producer.publish([form("old", "Earlier form")]);
    });
    await waitForFrame(setup, (frame) => frame.includes("Earlier form"));
    act(() => {
      producer.publish([form("new", "Replacement form")]);
    });
    await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Replacement form") && !frame.includes("Earlier form"),
    );
    expect(producer.calls).toEqual([]);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.calls[0]?.input).toEqual({
      id: "new",
      decision: "approve",
      expectedRevision: 7,
    });
    expect(producer.calls).toHaveLength(1);
  } finally {
    await close();
  }
});

test("appending a pending form preserves the current human selection and drains source order", async () => {
  const { producer, setup, close } = await mount();
  const first = form("first", "First form");
  const second = form("second", "Second form");
  try {
    act(() => {
      producer.publish([first]);
    });
    await waitForFrame(setup, (frame) => frame.includes("First form"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    act(() => {
      producer.publish([first, second]);
    });
    await waitForFrame(
      setup,
      (frame) => frame.includes("First form") && !frame.includes("Second form"),
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, (frame) => frame.includes("Second form"));
    expect(producer.calls.map((call) => call.input)).toEqual([
      { id: "first", decision: "deny", expectedRevision: 7 },
    ]);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEscape();
    });
    expect(producer.calls.map((call) => call.input)).toEqual([
      { id: "first", decision: "deny", expectedRevision: 7 },
    ]);
  } finally {
    await close();
  }
});

test("losing an answer response is an unconfirmed outcome, never success or automatic retry", async () => {
  const { producer, setup, close } = await mount(() =>
    Promise.reject(new Error("Response lost")),
  );
  try {
    act(() => {
      producer.publish([form("unconfirmed")]);
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Allow computer · exec?"),
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Couldn't send your answer.") &&
        frame.includes("not have been recorded."),
    );
    expect(producer.calls).toHaveLength(1);
  } finally {
    await close();
  }
});

test("closing the client releases its watch without answering through a dead attachment", async () => {
  const { producer, setup, close } = await mount();
  try {
    act(() => {
      producer.publish([form("closing")]);
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Allow computer · exec?"),
    );
    await close();
    expect(producer.calls).toEqual([]);
    expect(producer.fixture.closeCalls()).toBe(1);
  } finally {
    if (!setup.renderer.isDestroyed) await close();
  }
});

test("a read-only Session view never offers or sends an approval", async () => {
  const { producer, setup, close } = await mount();
  try {
    const pending = form("read-only");
    act(() => {
      producer.publish([
        { ...pending, approval: { ...pending.approval, canAnswer: false } },
      ]);
    });
    // Nothing to answer: the composer stays the composer.
    await act(async () => setup.renderOnce());
    const frame = await waitForFrame(setup, (frame) =>
      frame.includes("Ask anything"),
    );
    expect(frame).not.toContain("Approve");
    expect(frame).not.toContain("Deny");
    expect(frame).not.toContain("Allow computer");
    expect(producer.calls).toEqual([]);
  } finally {
    await close();
  }
});

test("a dismissed presentation leaves the record pending and a new revision can be answered", async () => {
  const { producer, setup, close } = await mount();
  try {
    act(() => {
      producer.publish([form("same", "Revision seven", 7)]);
    });
    await waitForFrame(setup, (frame) => frame.includes("Revision seven"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEscape();
    });
    await waitForFrame(setup, (frame) => !frame.includes("Revision seven"));
    expect(producer.calls).toEqual([]);
    act(() => {
      producer.publish([form("same", "Revision eight", 8)]);
    });
    await waitForFrame(setup, (frame) => frame.includes("Revision eight"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(producer.calls[0]?.input).toEqual({
      id: "same",
      decision: "approve",
      expectedRevision: 8,
    });
    expect(producer.calls).toHaveLength(1);
  } finally {
    await close();
  }
});

test("a submitted-only result is unconfirmed, never a completed approval", async () => {
  const { producer, setup, close } = await mount(() =>
    Promise.resolve({ kind: "submitted" }),
  );
  try {
    act(() => {
      producer.publish([form("unconfirmed-submit")]);
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Allow computer · exec?"),
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Couldn't send your answer."),
    );
    expect(producer.calls).toHaveLength(1);
  } finally {
    await close();
  }
});
