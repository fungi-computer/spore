import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
if (entry === undefined) throw new Error("Pass the installed CLI bundle path");
const { runFungiCli } = await import(pathToFileURL(entry).href);
const pending = Promise.withResolvers();
let emit;
let watchClosed = false;
let hostClosed = false;
let commandId;
const session = {
  abort: async () => {
    throw new Error("Fixture must not abort");
  },
  command: async ({ text, requestId }) => {
    assert.equal(text, "packed fixture prompt");
    commandId = requestId;
    pending.resolve();
    return { status: "accepted", commandId: requestId };
  },
  watch: async () => ({
    changes: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((resolve) => {
            emit = resolve;
          }),
        return: async () => ({ done: true }),
      }),
    },
    close: async () => {
      watchClosed = true;
    },
  }),
};
let result = "";
const run = runFungiCli(
  ["run", "packed fixture prompt"],
  {
    stdout: {
      write(value, callback) {
        result += value;
        callback?.();
        return true;
      },
    },
  },
  {
    createServiceManager: () => ({
      connect: async () => ({
        sandboxStatus: async () => ({
          mode: "full-access",
          available: true,
        }),
        session,
        close: async () => {
          hostClosed = true;
        },
      }),
    }),
  },
);
await pending.promise;
for (let attempt = 0; emit === undefined && attempt < 100; attempt += 1)
  await setTimeout(10);
assert.ok(emit, "one-shot watcher did not start");
emit({
  done: false,
  value: {
    kind: "update",
    messages: [
      {
        sequence: 1,
        commandId,
        value: { role: "user", content: "packed fixture prompt" },
      },
      {
        sequence: 2,
        commandId,
        value: {
          role: "assistant",
          content: [{ type: "text", text: "PACKED_CLI_OK" }],
        },
      },
    ],
    terminals: [{ commandId, outcome: "completed" }],
  },
});
await run;
assert.equal(result, "PACKED_CLI_OK\n");
assert.equal(watchClosed, true);
assert.equal(hostClosed, true);
console.log(result.trim());

let inspectionOutput = "";
let inspectionClosed = false;
const inspectionSessionId = "session_packed_fixture";
await runFungiCli(
  ["sessions", "show", "--last", "--errors", "--json"],
  {
    stdout: {
      write(value, callback) {
        inspectionOutput += value;
        callback?.();
        return true;
      },
    },
  },
  {
    createServiceManager: () => ({
      discover: async () => ({
        agents: [
          {
            agentId: "one",
            databasePath: "/project/one/agent.sqlite",
            sessionCount: 1,
          },
        ],
        sessions: [
          {
            sessionId: inspectionSessionId,
            databasePath: "/tmp/packed-fixture.sqlite",
            title: "Packed fixture",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        problems: [],
      }),
      inspect: async (_selection, options) => {
        assert.equal(options.limit, 100);
        return {
          snapshot: {
            sessionId: inspectionSessionId,
            cursor: "2",
            hasMore: false,
            messages: [
              {
                id: "failed-tool",
                data: {
                  error: {
                    kind: "not_found",
                    message: "Expected lines missing",
                  },
                },
                sequence: 2,
                commandId: "prompt-1",
                value: {
                  role: "toolResult",
                  toolCallId: "call-1",
                  toolName: "files.edit",
                  content: [{ type: "text", text: "Expected lines missing" }],
                  isError: true,
                  timestamp: 2,
                },
              },
            ],
            terminals: [
              {
                commandId: "prompt-1",
                outcome: "failed",
                sequence: 6,
                diagnostic: "Tool failed",
              },
            ],
            pending: { total: 0, prompts: [], hasMore: false },
            activity: {
              queue: { state: "idle" },
              cancellationRequested: false,
              retry: null,
              activeTool: null,
              lastModelChoiceSequence: null,
              compaction: null,
            },
            toolOutput: [],
            progress: null,
            extensions: {},
            attention: [],
          },
          session: {
            watch: () => Promise.reject(new Error("show must not watch")),
          },
          close: async () => {
            inspectionClosed = true;
          },
        };
      },
    }),
  },
);
const inspected = JSON.parse(inspectionOutput);
assert.equal(inspected.sessionId, inspectionSessionId);
assert.deepEqual(
  inspected.messages.map((message) => message.error),
  [{ kind: "not_found", message: "Expected lines missing" }],
);
assert.deepEqual(inspected.errors, [
  { kind: "session_error", message: "Tool failed" },
]);
assert.equal(inspectionClosed, true);
console.log("PACKED_SESSION_INSPECTION_OK");
