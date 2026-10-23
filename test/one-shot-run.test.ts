import type {
  OperatorCommand,
  TitleCommand,
} from "@fungi.computer/shiitake/client";
import type {
  PrivateLocalServiceManager,
  PrivateLocalServiceConnection,
} from "@fungi.computer/truffle/service";
import {
  idleActivity,
  queuedActivity,
  runningActivity,
} from "@fungi.computer/parakeet-testing";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "bun:test";

import type {
  Accepted,
  SessionFrame,
  SessionMessage,
  SessionTerminal,
  ShiitakeSession,
  SessionCommand,
  CompactCommand,
  PromptCommand,
  CancelCommand,
  CancelResult,
  AbortCommand,
  BranchCommand,
  ForkCommand,
  ForkedSession,
} from "@fungi.computer/shiitake";
import { runFungiCli } from "../src/cli.js";
import { runOneShotCli } from "../src/one-shot-cli.js";
import {
  connectPrivateLocalBunShiitakeHost,
  openPrivateLocalBunShiitakeWorkerBatch,
} from "../src/private-bun-shiitake-host.js";
import {
  readOneShotPrompt,
  runOneShot,
  type OneShotSession,
} from "../src/one-shot-run.js";

function fakeSession(
  initialStatus: "idle" | "streaming" = "idle",
  expectedPrompt = "prompt from stdin",
  commandFailure = false,
  abortFailure = false,
  closeFailure = false,
  watchFailure?: Error,
  commandResult?: Promise<Accepted>,
) {
  const events: string[] = [];
  const submitted = Promise.withResolvers<undefined>();
  const frames: SessionFrame[] = [];
  const waiters: ((result: IteratorResult<SessionFrame>) => void)[] = [];
  let watchClosed = 0;
  let abortCalls = 0;
  let commandCalls = 0;
  let acceptedRequestId = "request-1";
  let ended = false;
  // SAFETY: The fake iterator yields only decoded SessionFrame values.
  const changes: AsyncIterable<SessionFrame> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (watchFailure !== undefined) return Promise.reject(watchFailure);
          const frame = frames.shift();
          if (frame !== undefined)
            return Promise.resolve({ done: false, value: frame });
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<SessionFrame>>((resolve) =>
            waiters.push(resolve),
          );
        },
        return: () => {
          ended = true;
          for (const resolve of waiters.splice(0))
            resolve({ done: true, value: undefined });
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  const command: OneShotSession["command"] = (input) => {
    commandCalls += 1;
    events.push("command");
    assert.equal(input.requestId.length > 0, true);
    assert.equal(input.text, expectedPrompt);
    acceptedRequestId = input.requestId;
    submitted.resolve(undefined);
    if (commandResult !== undefined) return commandResult;
    if (commandFailure) throw new Error("command rejected prompt");
    return Promise.resolve({
      status: "accepted",
      commandId: acceptedRequestId,
    });
  };
  const session: OneShotSession = {
    command,
    abort: () => {
      abortCalls += 1;
      if (abortFailure) throw new Error("abort failed");
      return Promise.resolve();
    },
    watch: () => {
      events.push("watch");
      return Promise.resolve({
        snapshot: {
          pending: { total: 0, prompts: [], hasMore: false },
          sessionId: "session-1",
          cursor: null,
          hasMore: false,
          messages: [],
          terminals: [],
          activity:
            initialStatus === "streaming" ? runningActivity() : idleActivity,
          toolOutput: [],
          progress: null,
          extensions: {},
          attention: [],
        },
        changes,
        close: () => {
          watchClosed += 1;
          ended = true;
          for (const resolve of waiters.splice(0))
            resolve({ done: true, value: undefined });
          if (closeFailure) throw new Error("watch close failed");
          return Promise.resolve();
        },
      });
    },
  };
  return {
    session,
    events,
    submitted: submitted.promise,
    emit(frame: SessionFrame) {
      const resolve = waiters.shift();
      if (resolve !== undefined) resolve({ done: false, value: frame });
      else frames.push(frame);
    },
    end() {
      ended = true;
      for (const resolve of waiters.splice(0))
        resolve({ done: true, value: undefined });
    },
    get commandCalls() {
      return commandCalls;
    },
    get requestId() {
      return acceptedRequestId;
    },
    get abortCalls() {
      return abortCalls;
    },
    get watchClosed() {
      return watchClosed;
    },
  };
}

function assistant(
  sequence: number,
  text: string,
  stopReason: "stop" | "error" | "aborted" | "toolUse" = "stop",
  requestId = "request-1",
  content: Extract<
    SessionMessage["value"],
    { role: "assistant" }
  >["content"] = [{ type: "text", text }],
): SessionMessage {
  return {
    id: `assistant-${String(sequence)}`,
    sequence,
    commandId: requestId,
    value: {
      role: "assistant",
      content,
      stopReason,
      api: "pi",
      provider: "fixture",
      model: "fixture",
      timestamp: sequence,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

function toolResult(sequence: number, requestId: string): SessionMessage {
  return {
    id: `tool-result-${String(sequence)}`,
    sequence,
    commandId: requestId,

    value: {
      role: "toolResult",
      toolCallId: "tool-call-1",
      toolName: "lookup",
      content: [{ type: "text", text: "tool result" }],
      isError: false,
      timestamp: 1,
    },
  };
}

function user(sequence: number, requestId = "request-1"): SessionMessage {
  return {
    id: "user-1",
    sequence,
    commandId: requestId,
    value: {
      role: "user",
      content: "prompt from stdin",
      timestamp: 1,
    },
  };
}

function idleFrame(
  messages: readonly SessionMessage[],
  terminals: readonly SessionTerminal[] = [
    ...new Set(
      messages.flatMap((message) =>
        message.value.role === "assistant" && message.commandId !== null
          ? [message.commandId]
          : [],
      ),
    ),
  ].map((requestId) => ({
    commandId: requestId,
    outcome: "completed" as const,
    sequence: 1,
    diagnostic: null,
  })),
): SessionFrame {
  return {
    pending: { total: 0, prompts: [], hasMore: false },
    kind: "update",
    delivery: "live",
    cursor: "cursor-1",
    messages,
    terminals,
    activity: idleActivity,
    extensions: {},
    attention: [],
  };
}

function outputSink(output: string[]): Writable {
  return new Writable({
    write(value, _encoding, complete) {
      output.push(String(value));
      complete();
    },
  });
}

/** Supports prompts and rejects commands outside this one-shot scenario. */
function serviceManager(
  oneShot: OneShotSession,
  close: () => Promise<void> = () => Promise.resolve(),
): PrivateLocalServiceManager {
  function command(input: PromptCommand | CompactCommand): Promise<Accepted>;
  function command(input: CancelCommand): Promise<CancelResult>;
  function command(
    input: AbortCommand | BranchCommand | OperatorCommand | TitleCommand,
  ): Promise<undefined>;
  function command(input: ForkCommand): Promise<ForkedSession>;
  function command(
    input: SessionCommand,
  ): Promise<Accepted | CancelResult | ForkedSession | undefined>;
  function command(
    input: SessionCommand,
  ): Promise<Accepted | CancelResult | ForkedSession | undefined> {
    if (input.type === "prompt") return oneShot.command(input);
    return Promise.reject(
      new Error("Only prompts are used in this one-shot fixture"),
    );
  }
  const session: ShiitakeSession = {
    withdraw: () => Promise.resolve({ status: "unknown" }),
    address: "fixture://main",
    latestPending: () =>
      Promise.reject(
        new Error("pending lookup is unused in this one-shot fixture"),
      ),
    command,
    abort: oneShot.abort,
    watch: oneShot.watch,
    read: () =>
      Promise.reject(new Error("read is unused in this one-shot fixture")),
    subscribe: () => {
      throw new Error("subscribe is unused in this one-shot fixture");
    },
    send: () =>
      Promise.reject(new Error("send is unused in this one-shot fixture")),
    cancel: () =>
      Promise.reject(new Error("cancel is unused in this one-shot fixture")),
    extension: () => ({
      call: () =>
        Promise.reject(
          new Error("extensions are unused in this one-shot fixture"),
        ),
    }),
    modelPreference: {
      read: () => Promise.resolve(null),
      set: () =>
        Promise.reject(
          new Error(
            "model preference writes are unused in this one-shot fixture",
          ),
        ),
    },
  };
  const host: PrivateLocalServiceConnection = {
    stopAll: () =>
      Promise.reject(new Error("stopAll is unused in this one-shot fixture")),
    agentId: "fixture-agent",
    databasePath: "/tmp/one-shot.sqlite",
    sessionId: "main",
    service: {
      protocol: 3,
      diagnostics: { state: "active" },
      version: "source",
      serviceId: "fixture",
      pid: 1,
      baseUrl: "http://fixture",
    },
    session,
    sandboxStatus: () =>
      Promise.reject(
        new Error("sandboxStatus is unused in this one-shot fixture"),
      ),
    effectiveModel: () =>
      Promise.reject(
        new Error("effectiveModel is unused in this one-shot fixture"),
      ),
    rebind: () =>
      Promise.reject(new Error("rebind is unused in this one-shot fixture")),
    client: {
      session: () => session,
      createSession: () =>
        Promise.reject(
          new Error("createSession is unused in this one-shot fixture"),
        ),
      deleteSession: () =>
        Promise.reject(
          new Error("deleteSession is unused in this one-shot fixture"),
        ),
      listSessions: () =>
        Promise.reject(
          new Error("listSessions is unused in this one-shot fixture"),
        ),
      extensions: {
        list: () =>
          Promise.reject(
            new Error("extensions are unused in this one-shot fixture"),
          ),
        resume: () =>
          Promise.reject(
            new Error("resume is unused in this one-shot fixture"),
          ),
        call: () =>
          Promise.reject(
            new Error("extension call is unused in this one-shot fixture"),
          ),
      },
      close,
    },
    close,
  };
  return {
    connect: () => Promise.resolve(host),
    reload: () =>
      Promise.reject(new Error("reload is unused in this one-shot fixture")),
    status: () =>
      Promise.reject(new Error("status is unused in this one-shot fixture")),
    start: () =>
      Promise.reject(new Error("start is unused in this one-shot fixture")),
    createSession: () =>
      Promise.reject(
        new Error("createSession is unused in this one-shot fixture"),
      ),
    discover: () =>
      Promise.reject(new Error("discover is unused in this one-shot fixture")),
    archive: () =>
      Promise.reject(new Error("archive is unused in this one-shot fixture")),
    inspect: () =>
      Promise.reject(new Error("inspect is unused in this one-shot fixture")),
    auth: () =>
      Promise.reject(new Error("auth is unused in this one-shot fixture")),
    models: () =>
      Promise.reject(new Error("models is unused in this one-shot fixture")),
    stop: () =>
      Promise.reject(new Error("stop is unused in this one-shot fixture")),
  };
}

test("fungi reload prints the service result and sends the selected project without starting or stopping", async () => {
  const fake = fakeSession();
  const output: string[] = [];
  const roots: string[] = [];
  await runFungiCli(
    ["reload", "-C", "project"],
    {
      cwd: "/workspace",
      stdout: outputSink(output),
    },
    {
      createServiceManager: () => ({
        ...serviceManager(fake.session),
        reload: (root) => {
          roots.push(root);
          return Promise.resolve(
            "Configuration reloaded; applies from the next turn",
          );
        },
      }),
    },
  );
  assert.deepEqual(roots, ["/workspace/project"]);
  assert.match(
    output.join(""),
    /Configuration reloaded; applies from the next turn/u,
  );
});

test("dispatcher follows the owner command ID and closes its Session watch", async () => {
  const fake = fakeSession();
  const session: OneShotSession = {
    ...fake.session,
    command: async (input) => {
      await fake.session.command(input);
      return { status: "accepted", commandId: "owner-command-1" };
    },
  };
  const output: string[] = [];
  const run = runFungiCli(
    ["run"],
    {
      cwd: "/tmp",
      stdin: Readable.from(["prompt from stdin"]),
      stdout: outputSink(output),
    },
    {
      createServiceManager: () => serviceManager(session),
    },
  );
  await Promise.race([fake.submitted, run]);
  assert.deepEqual(fake.events.slice(0, 2), ["watch", "command"]);
  fake.emit(
    idleFrame([
      user(1, "owner-command-1"),
      assistant(2, "tool-call assistant", "stop", "owner-command-1"),
      assistant(3, "final durable output", "stop", "owner-command-1"),
    ]),
  );
  await run;
  assert.deepEqual(output, ["final durable output\n"]);
  assert.equal(fake.commandCalls, 1);
  assert.equal(fake.watchClosed, 1);
});

test("one-shot mints a Cairn replay key for a new command", async () => {
  const fake = fakeSession();
  const output: string[] = [];
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    stdout: outputSink(output),
  });
  await Promise.race([fake.submitted, run]);
  assert.match(
    fake.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  fake.emit(
    idleFrame([
      user(1, fake.requestId),
      assistant(2, "done", "stop", fake.requestId),
    ]),
  );
  await run;
  assert.deepEqual(output, ["done\n"]);
});

test("normal completion never aborts the accepted Session", async () => {
  const fake = fakeSession();
  const output: string[] = [];
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
    stdout: outputSink(output),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  fake.emit(idleFrame([user(1), assistant(2, "normal output")]));
  await run;
  assert.deepEqual(output, ["normal output\n"]);
  assert.equal(fake.abortCalls, 0);
});

test("installed dispatcher accepts one positional prompt", async () => {
  const fake = fakeSession("idle", "prompt from argv");
  const output: string[] = [];
  const run = runFungiCli(
    ["run", "prompt from argv"],
    {
      cwd: "/tmp",
      stdout: outputSink(output),
    },
    {
      createServiceManager: () => serviceManager(fake.session),
    },
  );
  await Promise.race([fake.submitted, run]);
  fake.emit(
    idleFrame([
      user(1, fake.requestId),
      assistant(2, "argv output", "stop", fake.requestId),
    ]),
  );
  await run;
  assert.deepEqual(output, ["argv output\n"]);
  assert.equal(fake.commandCalls, 1);
}, 30_000);

test("a false Writable result stays pending until its callback completes", async () => {
  const fake = fakeSession();
  let complete!: (cause?: Error | null) => void;
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
    stdout: new Writable({
      highWaterMark: 1,
      write: (_value, _encoding, callback) => {
        complete = callback;
      },
    }),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  fake.emit(idleFrame([user(1), assistant(2, "delayed output")]));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.watchClosed, 0);
  complete();
  await run;
  assert.equal(fake.watchClosed, 1);
});

test("connected fungi run reports the single service path honestly", async () => {
  await assert.rejects(
    runFungiCli(["run", "--connect", "http://127.0.0.1:43123", "prompt"]),
    /--connect is unavailable; fungi uses the persistent Local service/u,
  );
});

test("an asynchronous Writable error keeps its original Error identity", async () => {
  const fake = fakeSession();
  const writeFailure = new Error("output pipe failed");
  const output = new Writable({
    highWaterMark: 1,
    write: (_value, _encoding, callback) => {
      complete = callback;
    },
  });
  output.once("error", (cause) => {
    assert.equal(cause, writeFailure);
  });
  let complete!: (cause?: Error | null) => void;
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
    stdout: output,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  fake.emit(idleFrame([user(1), assistant(2, "not delivered")]));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  complete(writeFailure);
  await assert.rejects(run, (cause) => cause === writeFailure);
  assert.equal(fake.watchClosed, 1);
});

test("stdin is bounded and empty input is visible", async () => {
  assert.equal(
    await readOneShotPrompt(Readable.from(["prompt from stdin"])),
    "prompt from stdin",
  );
  assert.equal(
    await readOneShotPrompt(
      Readable.from([Buffer.from([0xf0, 0x9f]), Buffer.from([0x98, 0x80])]),
    ),
    "😀",
  );
  await assert.rejects(readOneShotPrompt(Readable.from([])), /empty/u);
  await assert.rejects(
    readOneShotPrompt(Readable.from(["x".repeat(256 * 1024 + 1)])),
    /too large/u,
  );
});

test("progress and missing durable assistant results never print fabricated output", async () => {
  const fake = fakeSession();
  const output: string[] = [];
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
    stdout: outputSink(output),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  fake.emit({
    kind: "progress",
    activity: runningActivity(),
    progress: {
      messageId: "live",
      revision: 1,
      text: "not durable",
      thinking: "",
      textTruncated: false,
      thinkingTruncated: false,
    },
  });
  fake.emit(idleFrame([user(1)]));
  fake.end();
  await assert.rejects(run, /watch ended/u);
  assert.deepEqual(output, []);
  assert.equal(fake.watchClosed, 1);
});

test("command rejection is neutral and still closes the Session watch", async () => {
  const fake = fakeSession("idle", "prompt from stdin", true);
  await assert.rejects(
    runOneShot(fake.session, {
      prompt: "prompt from stdin",
      requestId: "request-1",
    }),
    /command rejected prompt/u,
  );
  assert.equal(fake.watchClosed, 1);
});

test("error and aborted assistant terminals are not successful output", async () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const fake = fakeSession();
    const output: string[] = [];
    const run = runOneShot(fake.session, {
      prompt: "prompt from stdin",
      requestId: "request-1",
      stdout: outputSink(output),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    fake.emit(
      idleFrame(
        [user(1), assistant(2, "failed text", stopReason)],
        [
          {
            commandId: "request-1",
            outcome: "failed",
            sequence: 1,
            diagnostic: "model:rejected: Model acquisition failed",
          },
        ],
      ),
    );
    await assert.rejects(
      run,
      /^Error: No model is available\. Run \/login to sign in/u,
    );
    assert.deepEqual(output, []);
  }
});

test("two one-shot clients correlate their own results while a TUI watch stays attached", async () => {
  type Watcher = {
    frames: SessionFrame[];
    waiters: ((result: IteratorResult<SessionFrame>) => void)[];
    closed: boolean;
  };
  const watchers: Watcher[] = [];
  const commands: string[] = [];
  const session: OneShotSession = {
    command: (input) => {
      commands.push(input.requestId);
      return Promise.resolve({
        status: "accepted",
        commandId: input.requestId,
      });
    },
    abort: () => Promise.resolve(),
    watch: () => {
      const watcher: Watcher = { frames: [], waiters: [], closed: false };
      watchers.push(watcher);
      const changes: AsyncIterable<SessionFrame> = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const frame = watcher.frames.shift();
            if (frame !== undefined)
              return Promise.resolve({ done: false, value: frame });
            if (watcher.closed)
              return Promise.resolve({ done: true, value: undefined });
            return new Promise<IteratorResult<SessionFrame>>((resolve) =>
              watcher.waiters.push(resolve),
            );
          },
          return: () => {
            watcher.closed = true;
            for (const resolve of watcher.waiters.splice(0))
              resolve({ done: true, value: undefined });
            return Promise.resolve({ done: true, value: undefined });
          },
        }),
      };
      return Promise.resolve({
        snapshot: {
          pending: { total: 0, prompts: [], hasMore: false },
          sessionId: "main",
          cursor: null,
          hasMore: false,
          messages: [],
          terminals: [],
          activity: idleActivity,
          toolOutput: [],
          progress: null,
          extensions: {},
          attention: [],
        },
        changes,
        close: () => {
          watcher.closed = true;
          for (const resolve of watcher.waiters.splice(0))
            resolve({ done: true, value: undefined });
          return Promise.resolve();
        },
      });
    },
  };
  const uiWatch = await session.watch();
  const uiChanges: AsyncIterator<SessionFrame> =
    uiWatch.changes[Symbol.asyncIterator]();
  const firstOutput: string[] = [];
  const secondOutput: string[] = [];
  const first = runOneShot(session, {
    prompt: "first",
    requestId: "first-request",
    stdout: outputSink(firstOutput),
  });
  const second = runOneShot(session, {
    prompt: "second",
    requestId: "second-request",
    stdout: outputSink(secondOutput),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(commands, ["first-request", "second-request"]);

  const firstFrame: SessionFrame = {
    pending: { total: 0, prompts: [], hasMore: false },
    kind: "update",
    delivery: "live",
    cursor: "cursor-1",
    messages: [
      user(1, "first-request"),
      user(2, "second-request"),
      assistant(3, "tool call", "toolUse", "first-request", [
        {
          type: "toolCall",
          id: "tool-call-1",
          name: "lookup",
          arguments: {},
        },
      ]),
      toolResult(4, "first-request"),
    ],
    terminals: [],
    // Both commands are accepted before either assistant is durable.
    activity: queuedActivity("queued-command"),
    extensions: {},
    attention: [],
  };
  const secondFrame: SessionFrame = {
    pending: { total: 0, prompts: [], hasMore: false },
    kind: "update",
    delivery: "live",
    cursor: "cursor-2",
    messages: [assistant(5, "first result", "stop", "first-request")],
    terminals: [
      {
        commandId: "first-request",
        outcome: "completed",
        sequence: 1,
        diagnostic: null,
      },
    ],
    // The second accepted prompt is still unsettled here.
    activity: queuedActivity("queued-command"),
    extensions: {},
    attention: [],
  };
  const thirdFrame: SessionFrame = {
    pending: { total: 0, prompts: [], hasMore: false },
    kind: "update",
    delivery: "live",
    cursor: "cursor-3",
    messages: [assistant(6, "second result", "stop", "second-request")],
    terminals: [
      {
        commandId: "second-request",
        outcome: "completed",
        sequence: 1,
        diagnostic: null,
      },
    ],
    activity: idleActivity,
    extensions: {},
    attention: [],
  };
  for (const frame of [firstFrame, secondFrame, thirdFrame]) {
    for (const watcher of watchers) {
      const resolve = watcher.waiters.shift();
      if (resolve !== undefined) resolve({ done: false, value: frame });
      else watcher.frames.push(frame);
    }
  }
  await Promise.all([first, second]);
  assert.deepEqual(firstOutput, ["first result\n"]);
  assert.deepEqual(secondOutput, ["second result\n"]);
  const uiFrame = await uiChanges.next();
  if (uiFrame.done) throw new Error("Missing TUI frame");
  assert.equal(uiFrame.value.kind, "update");
  assert.equal(uiFrame.value.messages[0]?.commandId, "first-request");
  await uiWatch.close();
});

test("cancellation aborts once and never prints progress", async () => {
  const fake = fakeSession("streaming");
  const listeners = new Map<string, () => void>();
  const output: string[] = [];
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
    stdout: outputSink(output),
    signals: {
      on: (name: string, handler: () => void) => listeners.set(name, handler),
      off: (name: string) => listeners.delete(name),
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const handler = listeners.get("SIGINT");
  assert(handler !== undefined);
  handler();
  await assert.rejects(run, /cancelled/u);
  assert.equal(fake.abortCalls, 1);
  assert.deepEqual(output, []);
  assert.equal(fake.watchClosed, 1);
});

test("connected cancellation observes without aborting shared work", async () => {
  const fake = fakeSession("streaming");
  const listeners = new Map<string, () => void>();
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "connected-request",
    abortOnSignal: false,
    signals: {
      on: (name: string, handler: () => void) => listeners.set(name, handler),
      off: (name: string) => listeners.delete(name),
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  listeners.get("SIGINT")?.();
  await assert.rejects(run, /cancelled/u);
  assert.equal(fake.abortCalls, 0);
  assert.equal(fake.watchClosed, 1);
});

test("a signal before acceptance waits to abort until acceptance", async () => {
  let resolveCommand!: (accepted: Accepted) => void;
  const commandResult = new Promise<Accepted>((resolve) => {
    resolveCommand = resolve;
  });
  const fake = fakeSession(
    "idle",
    "prompt from stdin",
    false,
    false,
    false,
    undefined,
    commandResult,
  );
  const listeners = new Map<string, () => void>();
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
    signals: {
      on: (name: string, handler: () => void) => listeners.set(name, handler),
      off: (name: string) => listeners.delete(name),
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const handler = listeners.get("SIGINT");
  assert(handler !== undefined);
  handler();
  assert.equal(fake.abortCalls, 0);
  resolveCommand({ status: "accepted", commandId: "request-1" });
  await assert.rejects(run, /cancelled/u);
  assert.equal(fake.abortCalls, 1);
});

test("abort failure is retained with the initiating cancellation", async () => {
  const fake = fakeSession("streaming", "prompt from stdin", false, true);
  const listeners = new Map<string, () => void>();
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
    signals: {
      on: (name: string, handler: () => void) => listeners.set(name, handler),
      off: (name: string) => listeners.delete(name),
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const handler = listeners.get("SIGINT");
  assert(handler !== undefined);
  handler();
  await assert.rejects(
    run,
    (cause) =>
      cause instanceof AggregateError &&
      cause.errors.some(
        (error) => error instanceof Error && error.message === "abort failed",
      ),
  );
  assert.equal(fake.abortCalls, 1);
});

test("an ended watch remains a visible one-shot failure", async () => {
  const fake = fakeSession();
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  fake.end();
  await assert.rejects(run, /watch ended/u);
  assert.equal(fake.watchClosed, 1);
});

test("a watch queue error is preserved while the watch still closes", async () => {
  const watchFailure = new Error("watch queue failed");
  const fake = fakeSession(
    "idle",
    "prompt from stdin",
    false,
    false,
    false,
    watchFailure,
  );
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
    stdout: outputSink([]),
  });
  await assert.rejects(run, (cause) => cause === watchFailure);
  assert.equal(fake.watchClosed, 1);
});

test("host cleanup failure remains visible after a durable result", async () => {
  const fake = fakeSession();
  const run = runOneShotCli(
    {
      invocationRoot: "/tmp",
      prompt: "prompt from stdin",
      requestId: "request-1",
      stdout: outputSink([]),
    },
    {
      createServiceManager: () =>
        serviceManager(fake.session, () => {
          throw new Error("host cleanup failed");
        }),
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  fake.emit(idleFrame([user(1), assistant(2, "output")]));
  await assert.rejects(run, /host cleanup failed/u);
});

test("watch close failure is retained after the initiating result", async () => {
  const fake = fakeSession("idle", "prompt from stdin", false, false, true);
  const run = runOneShot(fake.session, {
    prompt: "prompt from stdin",
    requestId: "request-1",
    stdout: outputSink([]),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  fake.emit(idleFrame([user(1), assistant(2, "output")]));
  await assert.rejects(run, /watch close failed/u);
});

test("rejects unsupported reasoning spellings before opening a host", async () => {
  for (const value of ["off", "ultra", "bogus"]) {
    await assert.rejects(
      runFungiCli(["run", "--reasoning", value, "prompt"]),
      /Invalid --reasoning value/u,
    );
  }
});

test("rejects launch-time model options before opening a service Session", async () => {
  await assert.rejects(
    runFungiCli(["run", "--model", "gpt-5.6-sol", "prompt from stdin"]),
    /Session model selection requires the shared Local preference contract/u,
  );
});

test("--listen is restricted to a fresh owning TUI", async () => {
  const listener = "http://127.0.0.1:43123";
  await assert.rejects(
    runFungiCli(["run", "--listen", listener, "prompt"]),
    /--listen is only valid with a fresh fungi TUI/u,
  );
  await assert.rejects(
    runFungiCli(["resume", "--listen", listener]),
    /--listen is only valid with a fresh fungi TUI/u,
  );
  await assert.rejects(
    runFungiCli(["--last", "--listen", listener, "resume"]),
    /--listen is only valid with a fresh fungi TUI/u,
  );
  await assert.rejects(
    runFungiCli(["run", "--connect", listener, "-C", "/tmp/project", "prompt"]),
    /--connect cannot be combined with local project or database options/u,
  );
});

test("loopback connection accepts the supported origin and rejects other URL shapes", async () => {
  const connected = await connectPrivateLocalBunShiitakeHost(
    "http://127.0.0.1:43123/workers/alpha",
  );
  assert.equal(connected.baseUrl, "http://127.0.0.1:43123/workers/alpha");
  await connected.close();
  for (const endpoint of [
    "https://127.0.0.1:43123",
    "http://example.com:43123",
    "http://user:password@127.0.0.1:43123",
    "http://127.0.0.1:43123/workers/alpha?token=hidden",
    "http://127.0.0.1:43123/workers/alpha#session",
  ])
    assert.throws(
      () => connectPrivateLocalBunShiitakeHost(endpoint),
      /Private local Shiitake endpoint/u,
    );
});

test("worker listener rejects before opening a local owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-worker-listener-"));
  try {
    await assert.rejects(
      async () =>
        openPrivateLocalBunShiitakeWorkerBatch(
          [{ name: "alpha", owner: { invocationRoot: root } }],
          "http://127.0.0.1:43123/workers/alpha",
        ),
      /Private local Shiitake listener requires an origin without a path/u,
    );
    await assert.rejects(
      access(join(root, ".fungi", "agents")),
      (cause: unknown) =>
        cause instanceof Error && "code" in cause && cause.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const isTTY of [true, false]) {
  test(`one-shot final output preserves pipe bytes and sanitizes only the terminal (${String(isTTY)})`, async () => {
    const fake = fakeSession();
    const output: string[] = [];
    const payload = "safe\u001b]52;c;Y21k\u0007\u009d\u0090\u202e end";
    const run = runOneShot(fake.session, {
      prompt: "prompt from stdin",
      stdout: {
        isTTY,
        write: outputSink(output).write.bind(outputSink(output)),
      },
    });
    await Promise.race([fake.submitted, run]);
    fake.emit(
      idleFrame([
        user(1, fake.requestId),
        assistant(2, payload, "stop", fake.requestId),
      ]),
    );
    await run;
    assert.deepEqual(output, [isTTY ? "safe end\n" : `${payload}\n`]);
  });
}
