import { expect, test } from "bun:test";
import { z } from "zod";

import { idleActivity } from "@fungi.computer/parakeet-testing";
import type { SessionSnapshot } from "@fungi.computer/shiitake/client";
import {
  inspectionRows,
  inspectionStateCauses,
  renderInspection,
  renderSessionStatus,
  runSessionInspection,
} from "../src/session-inspection.js";

const snapshot: SessionSnapshot = {
  attention: [],
  sessionId: "session_fixture",
  cursor: "2",
  hasMore: true,
  messages: [
    {
      id: "user-1",
      sequence: 1,
      commandId: "command-1",
      value: { role: "user", content: "inspect this", timestamp: 1 },
    },
    {
      id: "assistant-call-1",
      sequence: 2,
      commandId: "command-1",
      value: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-success",
            name: "files.read",
            arguments: { path: "README.md", offset: 0 },
          },
        ],
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
    {
      id: "tool-success-1",
      sequence: 3,
      commandId: "command-1",
      value: {
        role: "toolResult",
        toolCallId: "call-success",
        toolName: "files.read",
        content: [{ type: "text", text: "Successful file contents" }],
        isError: false,
        timestamp: 3,
      },
    },
    {
      id: "assistant-text-1",
      sequence: 4,
      commandId: "command-1",
      value: {
        role: "assistant",
        content: [{ type: "text", text: "The file looks good." }],
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 4,
      },
    },
    {
      id: "tool-1",
      sequence: 5,
      commandId: "command-1",
      value: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "files.edit",
        content: [{ type: "text", text: "Old text was not found" }],
        details: {
          error: { kind: "not-found", message: "Old text was not found" },
        },
        isError: true,
        timestamp: 2,
      },
    },
  ],
  terminals: [
    {
      commandId: "command-1",
      outcome: "failed",
      sequence: 6,
      diagnostic: "Tool failed",
    },
  ],
  pending: { total: 0, prompts: [], hasMore: false },
  activity: idleActivity,
  progress: null,
  extensions: {
    loop: {
      status: "stopped",
      revision: "rev-1",
      reason: "Loop projection failed",
    },
  },
};

test("show keeps a bounded typed tool cause in text and JSON", () => {
  expect(inspectionRows(snapshot, true)).toEqual([
    expect.objectContaining({
      role: "toolResult",
      error: { kind: "not-found", message: "Old text was not found" },
    }),
  ]);
  expect(renderInspection(snapshot, true, false)).toContain(
    "toolResult [not-found]: Old text was not found",
  );
  expect(inspectionStateCauses(snapshot)).toEqual([
    { kind: "session_error", message: "Tool failed" },
    {
      kind: "extension_stopped",
      extensionId: "loop",
      message: "Loop projection failed",
    },
  ]);
  expect(JSON.parse(renderInspection(snapshot, false, true))).toMatchObject({
    bounded: { limit: 100, hasMore: true },
    messages: [
      { role: "user" },
      { role: "assistant" },
      { role: "toolResult" },
      { role: "assistant" },
      { error: { kind: "not-found" }, role: "toolResult" },
    ],
    errors: [
      { kind: "session_error", message: "Tool failed" },
      { kind: "extension_stopped", extensionId: "loop" },
    ],
  });
});

test("plain show renders prompts, tool arguments, successful results, and assistant text", () => {
  const output = renderInspection(snapshot, false, false);
  expect(output).toContain("1 user: inspect this");
  expect(output).toContain(
    '2 assistant: files.read({"path":"README.md","offset":0})',
  );
  expect(output).toContain("3 toolResult: Successful file contents");
  expect(output).toContain("4 assistant: The file looks good.");
});

test("status exposes the typed owner state without returning transcript content", () => {
  const status = renderSessionStatus(snapshot, 123, true);
  expect(JSON.parse(status)).toEqual({
    schemaVersion: 2,
    sessionId: "session_fixture",
    state: "error",
    label: "error: Tool failed",
    viewState: { kind: "error", cause: "Tool failed" },
    activity: idleActivity,
    lastTerminal: {
      commandId: "command-1",
      outcome: "failed",
      sequence: 6,
      diagnostic: "Tool failed",
    },
    lastActivityAt: 123,
  });
  expect(status).not.toContain("inspect this");
  expect(renderSessionStatus(snapshot, 123, false)).toBe(
    "Session session_fixture · error: Tool failed\n",
  );
});

test("status keeps the exact failure after a model choice acknowledges it", () => {
  const raw = "Provider said:\n  quota   exhausted " + "x".repeat(300);
  const acknowledged: SessionSnapshot = {
    ...snapshot,
    activity: { ...idleActivity, lastModelChoiceSequence: 9 },
    terminals: [
      {
        commandId: "command-1",
        outcome: "failed",
        sequence: 6,
        diagnostic: raw,
      },
    ],
  };
  expect(
    JSON.parse(renderSessionStatus(acknowledged, 123, true)),
  ).toMatchObject({
    state: "waiting_for_you",
    label: "idle",
    lastTerminal: {
      commandId: "command-1",
      outcome: "failed",
      sequence: 6,
      diagnostic: raw,
    },
  });
});

test("status labels a retry countdown from the raw retry facts", () => {
  const retrying: SessionSnapshot = {
    ...snapshot,
    terminals: [],
    activity: {
      ...idleActivity,
      queue: { state: "running", commandId: "command-2" },
      retry: {
        attempt: 1,
        maxAttempts: 3,
        delayMs: 4_000,
        errorMessage: "503 Service Unavailable",
        scheduledAt: 10_000,
      },
    },
  };
  expect(
    JSON.parse(renderSessionStatus(retrying, 123, true, 11_000)),
  ).toMatchObject({
    state: "retrying",
    label: "retrying 1/3 · 503 Service Unavailable · next in 3s",
    lastTerminal: null,
  });
});

test("show reads through the Local service manager and closes its client", async () => {
  let closed = false;
  let output = "";
  const manager = {
    inspect: () =>
      Promise.resolve({
        snapshot,
        session: {
          watch: () => Promise.reject(new Error("show must not watch")),
        },
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      }),
  };
  await runSessionInspection({
    inspect: manager.inspect,
    selection: {
      invocationRoot: "/tmp/project",
      databasePath: "/tmp/project/.fungi/agents/a/agent.sqlite",
      sessionId: "session_fixture",
    },
    watch: false,
    errorsOnly: false,
    json: true,
    write(value) {
      output += value;
    },
  });
  expect(output).toContain('"sessionId":"session_fixture"');
  expect(closed).toBe(true);
});

test("operator inspection resolves sandbox references without treating diagnostics as messages", () => {
  const event = {
    kind: "sandbox_failure" as const,
    ref: "exec-proof",
    executionId: "exec-proof",
    adapter: "local-workerd",
    buildSha: "abc123",
    tag: "DispatchLost" as const,
    healthAlert: false,
    fields: {
      rawCause: {
        name: "TypeError",
        message: "operator-only transport detail",
        cause: { message: "nested operator detail" },
      },
    },
  };
  const inspected = { ...snapshot, sandboxFailures: [event] };
  const json = z
    .object({
      sandboxFailures: z.array(z.unknown()),
      messages: z.array(z.unknown()),
    })
    .parse(JSON.parse(renderInspection(inspected, true, true)));
  expect(json.sandboxFailures).toEqual([event]);
  expect(JSON.stringify(json.messages)).not.toContain(
    "operator-only transport detail",
  );
  expect(renderInspection(inspected, true, false)).toContain(
    "[sandbox_failure:DispatchLost] ref exec-proof",
  );
});

test("inspect and watch sanitize terminal fields without changing JSON message data", () => {
  const payload = "safe\u001b]52;c;Y21k\u0007\u009d\u0090\u202e end";
  const value: SessionSnapshot = {
    ...snapshot,
    messages: [
      {
        id: "display",
        sequence: 1,
        commandId: "display",
        value: { role: "user", content: payload, timestamp: 1 },
      },
    ],
    terminals: [
      {
        commandId: "display",
        sequence: 2,
        outcome: "failed",
        diagnostic: payload,
      },
    ],
    extensions: {
      loop: { status: "stopped", revision: "test", reason: payload },
    },
  };
  const text = renderInspection(value, false, false);
  expect(text).toContain("safe end");
  expect(text).not.toMatch(/[^\P{Cc}\n\t]|[\u202a-\u202e\u2066-\u2069]/u);
  expect(
    z
      .object({
        messages: z.array(
          z.object({ value: z.object({ content: z.string() }) }),
        ),
      })
      .parse(JSON.parse(renderInspection(value, false, true))).messages[0]
      ?.value.content,
  ).toBe(payload);
});

test("status sanitizes a failed Session cause", () => {
  const payload = "safe\u001b]52;c;Y21k\u0007\u009d\u202e end";
  const value: SessionSnapshot = {
    ...snapshot,
    terminals: [
      {
        commandId: "failed",
        sequence: 100,
        outcome: "failed",
        diagnostic: payload,
      },
    ],
  };
  expect(renderSessionStatus(value, 123, false)).toBe(
    "Session session_fixture · error: safe end\n",
  );
});

test("plain inspection explains diagnostics while JSON keeps the exact status and inspection bytes", () => {
  const diagnostic = "model:rejected: No model is signed in.";
  const stopped = "extension:failed: Could not refresh the loop.";
  const toolCause = "tool:failed: Old text was not found.";
  const message: SessionSnapshot["messages"][number] = {
    id: "tool-error",
    sequence: 1,
    commandId: "failed",
    value: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "files.edit",
      content: [{ type: "text", text: toolCause }],
      isError: true,
      details: { error: { kind: "not-found", message: toolCause } },
      timestamp: 1,
    },
  };
  const terminal: SessionSnapshot["terminals"][number] = {
    commandId: "failed",
    sequence: 2,
    outcome: "failed",
    diagnostic,
  };
  const value: SessionSnapshot = {
    ...snapshot,
    hasMore: false,
    messages: [message],
    terminals: [terminal],
    extensions: {
      loop: { status: "stopped", revision: "rev-1", reason: stopped },
    },
  };
  const viewState = { kind: "error", cause: diagnostic };
  expect(renderSessionStatus(value, 123, true)).toBe(
    JSON.stringify({
      schemaVersion: 2,
      sessionId: value.sessionId,
      state: "error",
      label: "error: No model is signed in.",
      viewState,
      activity: value.activity,
      lastTerminal: terminal,
      lastActivityAt: 123,
    }) + "\n",
  );
  expect(renderInspection(value, false, true)).toBe(
    JSON.stringify({
      sessionId: value.sessionId,
      bounded: { limit: 100, hasMore: false },
      activity: value.activity,
      viewState,
      messages: [
        {
          id: message.id,
          sequence: message.sequence,
          commandId: message.commandId,
          role: "toolResult",
          value: message.value,
          error: { kind: "not-found", message: toolCause },
        },
      ],
      errors: [
        { kind: "session_error", message: diagnostic },
        { kind: "extension_stopped", extensionId: "loop", message: stopped },
      ],
      terminals: [terminal],
      sandboxFailures: [],
      pending: value.pending,
    }) + "\n",
  );
  for (const plain of [
    renderSessionStatus(value, 123, false),
    renderInspection(value, false, false),
    renderInspection(value, true, false),
  ]) {
    expect(plain).not.toMatch(
      /model:rejected:|extension:failed:|tool:failed:/u,
    );
    expect(plain).toContain("No model is signed in.");
    expect(plain).not.toContain(JSON.stringify(terminal));
  }
  expect(renderInspection(value, false, false)).toContain(
    "Run failed · failed: No model is signed in.",
  );
  expect(renderInspection(value, false, false)).toContain(
    "Could not refresh the loop.",
  );
  expect(renderInspection(value, false, false)).toContain(
    "Old text was not found.",
  );
});
