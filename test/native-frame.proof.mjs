import { captureFrame } from "./frame-capture.js";
import { waitForFrame, pressDecodedKey } from "./native-readiness.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setImmediate as immediate } from "node:timers";
import { setTimeout as wait } from "node:timers/promises";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { createWhistleKeymapAdapter } from "@fungi.computer/whistle";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { TextareaRenderable, RGBA } from "@opentui/core";

import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { TuiFrame } from "@fungi.computer/spore/frame";
import { createTuiFixture } from "./fixture.js";
import { runThemeProof } from "./theme-native.proof.mjs";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

const require = createRequire(import.meta.url);
function renderedNodes(node) {
  return [node, ...node.getChildren().flatMap(renderedNodes)];
}

function boundedCompletion(promise, label) {
  return Promise.race([
    promise,
    wait(2000).then(() => {
      throw new Error(`${label} did not settle within 2s`);
    }),
  ]);
}

const reactPaths = [
  import.meta.url,
  import.meta.resolve("@fungi.computer/spore/frame"),
  import.meta.resolve("@fungi.computer/parakeet/headless"),
  require.resolve("@tanstack/react-query"),
  require.resolve("@opentui/react"),
  require.resolve("@opentui/react/test-utils"),
].map((resolver) => createRequire(resolver).resolve("react"));

assert.equal(
  new Set(reactPaths).size,
  1,
  `terminal hook/render paths resolved multiple React installations: ${JSON.stringify(reactPaths)}`,
);

const localRoot = await mkdtemp(join(tmpdir(), "fungi-tui-local-host-"));

// Focus the real CLI/renderer proof without running unrelated frame scenarios.
if (process.argv.includes("--session-picker")) {
  try {
    await runSessionPickerProof();
    process.stdout.write(
      "native resume-picker proof PASS (120 and 32 columns)\n",
    );
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
  process.exit(0);
}

const preRootEvents = [];
const preRootFailure = new Error("query construction failed");
await assert.rejects(
  runTuiCli(
    { invocationRoot: localRoot },
    {
      prepareClientExtensions: noOpClientExtensions,
      createServiceManager: () => ({}),
      renderConnecting: () => undefined,
      createRenderer: async () => ({
        destroy: () => preRootEvents.push("renderer-close"),
      }),
      createQueryClient: () => {
        preRootEvents.push("query");
        throw preRootFailure;
      },
    },
  ),
  (cause) => cause === preRootFailure,
);
assert.deepEqual(preRootEvents, ["query", "renderer-close"]);

const cleanupEvents = [];
const cleanupCommands = createWhistle();
const unmountFailure = new Error("unmount failed");
const clearFailure = new Error("clear failed");
const closeFailure = new Error("host close failed");
const destroyFailure = new Error("destroy failed");
await assert.rejects(
  runTuiCli(
    { invocationRoot: localRoot, databasePath: "/fixture/cleanup.sqlite" },
    {
      prepareClientExtensions: noOpClientExtensions,
      createServiceManager: () => ({
        connect: async () => ({
          agentId: "agent-fixture",
          sessionId: "session-fixture",
          databasePath: "/fixture/cleanup.sqlite",
          session: { address: "http://fixture/sessions/cleanup" },
          close: async () => {
            cleanupEvents.push("host-close");
            throw closeFailure;
          },
        }),
      }),
      renderConnecting: () => undefined,
      createQueryClient: () => ({
        clear: () => {
          cleanupEvents.push("clear");
          throw clearFailure;
        },
      }),
      createRenderer: async () => ({
        destroy: () => {
          cleanupEvents.push("destroy");
          throw destroyFailure;
        },
      }),
      createRoot: () => ({
        unmount: () => {
          cleanupEvents.push("unmount");
          throw unmountFailure;
        },
      }),
      createWhistle: () => cleanupCommands,
      render: (_root, _queryClient, _session, _commands, onExit) => {
        cleanupEvents.push("render");
        immediate(onExit);
      },
    },
  ),
  (cause) => {
    if (!(cause instanceof AggregateError)) return false;
    const leaves = (error) =>
      error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
    const actual = leaves(cause);
    assert.equal(actual.length, 4, "each cleanup failure is retained once");
    for (const expected of [
      unmountFailure,
      clearFailure,
      closeFailure,
      destroyFailure,
    ])
      assert.equal(actual.filter((error) => error === expected).length, 1);
    return true;
  },
);
assert.deepEqual(cleanupEvents, [
  "render",
  "unmount",
  "clear",
  "destroy",
  "host-close",
]);
assert.deepEqual(
  await cleanupCommands.execute("cleanup", { origin: "slash" }),
  {
    status: "closed",
  },
);

const whistle = createWhistle();
const slashCalls = [];
let slashHandlerCompleted = false;
const releaseSlashHandler = Promise.withResolvers();
let resolveSlashHandlerStarted;
const slashHandlerStarted = new Promise((resolve) => {
  resolveSlashHandlerStarted = resolve;
});
let resolveSlashHandlerCompletion;
const slashHandlerCompletion = new Promise((resolve) => {
  resolveSlashHandlerCompletion = resolve;
});
whistle.contribute({
  sourceId: "native-frame-proof",
  namespace: "native-frame",
  commands: [
    {
      id: "inspect",
      title: "Inspect",
      category: "proof",
      projections: { slash: { aliases: ["inspect"] } },
      handler: async (input) => {
        slashCalls.push(input);
        resolveSlashHandlerStarted();
        await releaseSlashHandler.promise;
        slashHandlerCompleted = true;
        resolveSlashHandlerCompletion();
      },
    },
  ],
});
const slashCommands = {
  contribute: whistle.contribute,
  snapshot: whistle.snapshot,
  subscribe: whistle.subscribe,
  execute: whistle.execute,
  present: whistle.present,
};
const slashFixture = createTuiFixture();
const slashQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const slashSetup = await testRender(
  createElement(
    QueryClientProvider,
    { client: slashQueryClient },
    createElement(TuiFrame, {
      commands: slashCommands,
      session: slashFixture.session,
    }),
  ),
  { height: 10, width: 48 },
);

try {
  await act(async () => slashSetup.renderOnce());
  await waitForFrame(slashSetup, (frame) =>
    frame.includes("Start a conversation."),
  );
  await act(async () => {
    await slashSetup.mockInput.typeText("/inspect");
  });
  await act(async () => {
    await slashSetup.mockInput.pressEnter();
    await slashHandlerStarted;
  });
  assert.equal(slashCalls.length, 1);
  assert.equal(slashCalls[0]?.origin, "slash");
  assert.ok(slashCalls[0]?.signal instanceof globalThis.AbortSignal);
  assert.equal(slashFixture.promptCalls(), 0);
  assert.equal(slashHandlerCompleted, false);
  releaseSlashHandler.resolve();
  await slashHandlerCompletion;
  assert.equal(slashHandlerCompleted, true);
  await act(async () => {
    await slashSetup.renderOnce();
  });

  await act(async () => {
    await slashSetup.mockInput.pressKey("u", { ctrl: true });
  });
  await act(async () => {
    await slashSetup.renderOnce();
  });
  await act(async () => {
    await slashSetup.mockInput.typeText("/inspect ");
  });
  await act(async () => {
    await slashSetup.renderOnce();
  });
  await act(async () => {
    await slashSetup.mockInput.pressEnter();
  });
  assert.equal(
    slashFixture.promptCalls(),
    0,
    "a trailing-space slash draft stays on the Whistle command path",
  );
  assert.equal(slashCalls.length, 2);

  await act(async () => {
    await slashSetup.mockInput.pressKey("u", { ctrl: true });
  });
  await act(async () => {
    await slashSetup.renderOnce();
  });
  await act(async () => {
    await slashSetup.mockInput.typeText("/unknown");
  });
  await act(async () => {
    await slashSetup.renderOnce();
  });
  await act(async () => {
    await slashSetup.mockInput.pressEnter();
  });
  assert.equal(
    slashFixture.promptCalls(),
    0,
    "an unknown slash draft is reported instead of sent to the model",
  );
  assert.match(slashSetup.captureCharFrame(), /\/unknown/u);
  assert.equal(slashCalls.length, 2);
} finally {
  await act(async () => {
    slashSetup.renderer.destroy();
  });
  assert.deepEqual(
    whistle.snapshot().slash.map((row) => row.alias),
    ["inspect"],
    "unmount disposes only the frame's command contribution",
  );
  slashQueryClient.clear();
  whistle.close();
}
await slashFixture.waitForClose();

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const ctrlFixture = createTuiFixture();
const ctrlSession = {
  ...ctrlFixture.session,
  modelPreference: {
    read: async () => null,
    set: async () => undefined,
  },
};
const ctrlCommands = createWhistle();
const ctrlQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const ctrlReady = Promise.withResolvers();
let ctrlSetup;
let ctrlHostCloses = 0;
const ctrlRunning = runTuiCli(
  { invocationRoot: "/tmp" },
  {
    prepareClientExtensions: noOpClientExtensions,
    loadThemePreference: async () => ({ theme: "terminal" }),
    createServiceManager: () => ({
      status: async () => undefined,
      start: async () => ({ serviceId: "fixture", baseUrl: "http://fixture" }),
      stop: async () => undefined,
      discover: async () => ({ agentCount: 1, sessions: [], problems: [] }),
      models: async () => [],
      auth: async () => undefined,
      createSession: async () => ({
        agentId: "agent-fixture",
        databasePath: "/fixture/main.sqlite",
        sessionId: "main",
        session: ctrlSession,
        close: async () => {
          ctrlHostCloses += 1;
        },
      }),
      connect: async () => ({
        agentId: "agent-fixture",
        databasePath: "/fixture/main.sqlite",
        sessionId: "main",
        session: ctrlSession,
        close: async () => {
          ctrlHostCloses += 1;
        },
      }),
    }),
    createWhistle: () => ctrlCommands,
    createQueryClient: () => ctrlQueryClient,
    enableKeymap: true,
    createRenderer: async (options) => {
      ctrlSetup = await createTestRenderer({
        ...options,
        height: 10,
        width: 48,
        useKittyKeyboard: null,
      });
      ctrlReady.resolve();
      return ctrlSetup.renderer;
    },
    createRoot,
  },
);
try {
  await ctrlReady.promise;
  await ctrlSetup.renderOnce();
  await waitForFrame(ctrlSetup, (frame) =>
    frame.includes("Start a conversation."),
  );
  await act(async () => {
    ctrlSetup.mockInput.pressKey("c", { ctrl: true });
    await boundedCompletion(ctrlRunning, "Ctrl+C frame exit");
  });
  assert.equal(ctrlHostCloses, 1, "Ctrl+C closes the Local host");
  assert.equal(ctrlSetup.renderer.isDestroyed, true);
} finally {
  if (!ctrlSetup?.renderer.isDestroyed)
    await ctrlCommands.execute("tui:exit", { origin: "slash" });
  await ctrlRunning;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
}
await ctrlFixture.waitForClose();
assert.equal(ctrlFixture.closeCalls(), 1);

await runSessionPickerProof();

const fixture = createTuiFixture();
let admittedRequestId;
let admittedDelivery;
const abortRequests = [];
const pendingAbort = Promise.withResolvers();
const abortObserved = Promise.withResolvers();
let exits = 0;
const observedSession = {
  ...fixture.session,
  command: async (input) => {
    if (input.type === "abort") {
      abortRequests.push(input);
      abortObserved.resolve();
      return pendingAbort.promise;
    }
    if (input.type === "prompt") {
      admittedRequestId = input.requestId;
      admittedDelivery = input.delivery;
    }
    return await fixture.session.command(input);
  },
};
const normalWhistle = createWhistle();
const normalCommands = {
  contribute: normalWhistle.contribute,
  snapshot: normalWhistle.snapshot,
  subscribe: normalWhistle.subscribe,
  execute: normalWhistle.execute,
  present: normalWhistle.present,
};
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const setup = await testRender(
  createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(TuiFrame, {
      commands: normalCommands,
      onExit: () => {
        exits += 1;
      },
      session: observedSession,
      initialTheme: "mocha",
    }),
  ),
  { height: 10, width: 48 },
);
const nativeKeymap = createDefaultOpenTuiKeymap(setup.renderer);
const normalKeymap = createWhistleKeymapAdapter(
  {
    registerLayer: (layer) =>
      nativeKeymap.registerLayer({
        ...layer,
        target: setup.renderer.root,
        priority: 100,
      }),
  },
  normalWhistle,
  "keyboard",
);

try {
  await act(async () => setup.renderOnce());
  await waitForFrame(setup, (frame) => frame.includes("Start a conversation."));
  const longPrompt =
    "Native prompt wraps across the narrow timeline with readable spaced text";
  await act(async () => {
    await setup.mockInput.typeText(longPrompt);
  });
  await setup.renderOnce();
  const narrowDraft = setup.captureCharFrame();
  assert.match(narrowDraft, /spaced text/);

  await act(async () => {
    await setup.mockInput.pressEnter();
  });
  await waitForFrame(
    setup,
    (frame) =>
      frame.includes("Steering · Native prompt") &&
      frame.includes("spaced text"),
  );
  assert.equal(
    admittedDelivery,
    "steer",
    "ordinary Enter uses the shared steer default",
  );
  assert.doesNotMatch(setup.captureCharFrame(), /you \(|assistant \(|tool \(/u);
  assert.equal(fixture.watchCalls(), 1);
  const pendingUserLine = setup
    .captureSpans()
    .lines.find((line) =>
      line.spans.some((span) => span.text.includes("Native prompt")),
    );
  assert.ok(pendingUserLine !== undefined);
  const pendingUserLabel = pendingUserLine.spans.find((span) =>
    span.text.includes("Steering ·"),
  );
  assert.ok(pendingUserLabel !== undefined);
  assert.ok(pendingUserLabel.fg.equals(RGBA.fromHex("#cdd6f4")));
  fixture.pushFrame({
    pending: { total: 0, prompts: [], hasMore: false },
    cursor: `fixture-${admittedRequestId}`,
    delivery: "live",
    kind: "update",
    messages: [
      {
        id: `owner-${admittedRequestId}`,
        commandId: `owner-${admittedRequestId}`,
        sequence: 1,
        value: { content: longPrompt, role: "user", timestamp: 0 },
      },
    ],
    terminals: [],
    activity: {
      queue: { state: "running", commandId: "running-command" },
      cancellationRequested: false,
      retry: null,
      activeTool: null,
      lastModelChoiceSequence: null,
      compaction: null,
    },
    extensions: {},
    attention: [],
  });
  await waitForFrame(
    setup,
    (frame) => frame.includes("Native prompt") && frame.includes("spaced text"),
  );
  fixture.pushFrame({
    kind: "progress",
    activity: {
      queue: { state: "running", commandId: "running-command" },
      cancellationRequested: false,
      retry: null,
      activeTool: null,
      lastModelChoiceSequence: null,
      compaction: null,
    },
    progress: {
      messageId: `assistant-${admittedRequestId}`,
      revision: 1,
      text: "Fixture is streaming a reply.",
      textTruncated: false,
      thinking: "",
      thinkingTruncated: false,
    },
  });
  const confirmedFrame = await waitForFrame(setup, (frame) =>
    frame.includes("Fixture is streaming a reply."),
  );

  const confirmedLines = confirmedFrame.split("\n");
  const firstPromptLine = confirmedLines.findIndex((line) =>
    line.includes("Native prompt"),
  );
  const lastPromptLine = confirmedLines.findLastIndex((line) =>
    line.includes("spaced text"),
  );
  assert.ok(
    firstPromptLine >= 0 && lastPromptLine > firstPromptLine,
    "long timeline content wraps across multiple rendered lines",
  );
  assert.match(confirmedFrame, /Fixture is streaming a reply\./);
  await act(async () => setup.waitForVisualIdle());
  const confirmedSpanLines = setup.captureSpans().lines;
  const confirmedUserLine = confirmedSpanLines.find((line) =>
    line.spans.some((span) => span.text.includes("Native prompt")),
  );
  assert.ok(confirmedUserLine !== undefined);
  const confirmedUserText = confirmedUserLine.spans.find((span) =>
    span.text.includes("Native prompt"),
  );
  assert.ok(confirmedUserText !== undefined);
  assert.ok(confirmedUserText.fg.equals(RGBA.fromHex("#cdd6f4")));
  const mutedUserSurface = RGBA.fromHex("#282839");
  assert.ok(
    confirmedUserText.bg.equals(mutedUserSurface),
    "confirmed user text shares the muted user surface",
  );
  assert.ok(
    confirmedUserLine.spans.every(
      (span, index) =>
        span.bg.equals(mutedUserSurface) ||
        // The native scroll viewport reserves its rightmost cell for the scrollbar.
        (index === confirmedUserLine.spans.length - 1 &&
          span.width === 1 &&
          /^[ ▄█]$/u.test(span.text) &&
          span.bg.equals(RGBA.fromHex("#1e1e2e"))),
    ),
    "confirmed user surface is uniform outside its right scrollbar gutter",
  );
  const streamingAssistantLine = confirmedSpanLines.find((line) =>
    line.spans.some((span) =>
      span.text.includes("Fixture is streaming a reply."),
    ),
  );
  assert.ok(streamingAssistantLine !== undefined);
  const streamingAssistantDot = streamingAssistantLine.spans.find((span) =>
    span.text.includes("●"),
  );
  assert.ok(streamingAssistantDot !== undefined);
  assert.ok(streamingAssistantDot.fg.equals(RGBA.fromHex("#89b4fa")));
  assert.doesNotMatch(
    setup.captureCharFrame(),
    /(?:you|assistant|tool) \((?:pending|confirmed|streaming|complete)\)|Session:/u,
  );

  for (let press = 0; press < 2; press += 1) {
    await pressDecodedKey(setup, () => setup.mockInput.pressEscape());
    if (press === 0)
      await boundedCompletion(abortObserved.promise, "Escape abort dispatch");
  }
  assert.deepEqual(abortRequests, [{ type: "abort" }]);
  assert.match(setup.captureCharFrame(), /Fixture is streaming a reply\./u);
  const composer = renderedNodes(setup.renderer.root).find(
    (node) => node instanceof TextareaRenderable,
  );
  assert.ok(composer?.focused, "Escape abort keeps the composer focused");
  assert.equal(exits, 0, "Escape abort does not exit the frame");
  pendingAbort.resolve();
  await act(async () => {
    await setup.renderOnce();
  });

  await act(async () => {
    setup.resize(72, 16);
  });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Native prompt/);
  await act(async () => {
    await setup.mockInput.typeText(" after resize");
  });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /after resize/);
  assert.ok(admittedRequestId !== undefined);
  await act(async () => {
    fixture.pushFrame({
      pending: { total: 0, prompts: [], hasMore: false },
      cursor: "fixture-terminal-failed",
      delivery: "live",
      kind: "update",
      messages: [],
      activity: {
        queue: { state: "idle" },
        cancellationRequested: false,
        retry: null,
        activeTool: null,
        lastModelChoiceSequence: null,
        compaction: null,
      },
      extensions: {},
      attention: [],
      terminals: [
        {
          outcome: "failed",
          commandId: `owner-${admittedRequestId}`,
          requestId: admittedRequestId,
          sequence: 2,
          diagnostic: "Fixture run failed",
        },
      ],
    });
    await setup.renderOnce();
  });
  await waitForFrame(setup, (frame) => frame.includes("error"));
  await act(async () => setup.mockInput.pressKey("u", { ctrl: true }));
  await act(async () => setup.mockInput.typeText("/exit"));
  await act(async () => setup.mockInput.pressEnter());
  assert.equal(exits, 1, "/exit remains the explicit frame exit");
  await act(async () => {
    setup.mockInput.pressKey("c", { ctrl: true });
  });
  assert.equal(exits, 2, "Ctrl+C routes through the frame exit callback");
} finally {
  await act(async () => {
    setup.renderer.destroy();
    normalKeymap.cleanup();
  });
  assert.deepEqual(normalWhistle.snapshot().slash, []);
  queryClient.clear();
  normalWhistle.close();
}

await fixture.waitForClose();
assert.equal(fixture.closeCalls(), 1);

const toolProofUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const toolProofMessages = [
  {
    id: "tool-proof-user",
    commandId: "tool-proof-request",
    sequence: 1,
    value: { role: "user", content: "Inspect three files", timestamp: 1 },
  },
  ...["a.ts", "b.ts", "c.ts"].flatMap((path, index) => {
    const sequence = 2 + index * 3;
    const id = `tool-proof-${String(index)}`;
    return [
      {
        id: `assistant-${id}`,
        commandId: null,
        sequence,
        value: {
          role: "assistant",
          api: "pi",
          provider: "camel",
          model: "auto",
          content: [
            { type: "toolCall", id, name: "read", arguments: { path } },
          ],
          stopReason: "toolUse",
          timestamp: sequence,
          usage: toolProofUsage,
        },
      },
      {
        id: `result-${id}`,
        commandId: null,
        sequence: sequence + 1,
        value: {
          role: "toolResult",
          toolCallId: id,
          toolName: "read",
          content: [{ type: "text", text: path }],
          isError: false,
          timestamp: sequence + 1,
        },
      },
      {
        id: `reasoning-${id}`,
        commandId: null,
        sequence: sequence + 2,
        value: {
          role: "assistant",
          api: "pi",
          provider: "camel",
          model: "auto",
          content: [
            {
              type: "thinking",
              thinking: index === 1 ? `Checking ${path}` : "   ",
            },
          ],
          stopReason: "stop",
          timestamp: sequence + 2,
          usage: toolProofUsage,
        },
      },
    ];
  }),
];
const toolProofFixture = createTuiFixture({ messages: toolProofMessages });
const toolProofClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const toolProofCommands = createWhistle();
const toolProofSetup = await testRender(
  createElement(
    QueryClientProvider,
    { client: toolProofClient },
    createElement(TuiFrame, {
      commands: toolProofCommands,
      session: toolProofFixture.session,
    }),
  ),
  { height: 24, width: 80 },
);
try {
  await act(async () => toolProofSetup.renderOnce());
  await waitForFrame(
    toolProofSetup,
    (frame) => frame.includes("Read 2 files") && frame.includes("Read c.ts"),
  );
  const frame = toolProofSetup.captureCharFrame();
  assert.equal(frame.match(/Read 2 files/gu)?.length, 1);
  assert.ok(frame.indexOf("Read 2 files") < frame.indexOf("Thinking"));
  assert.ok(frame.indexOf("Thinking") < frame.indexOf("Read c.ts"));
} finally {
  await act(async () => toolProofSetup.renderer.destroy());
  toolProofClient.clear();
  toolProofCommands.close();
}

await rm(localRoot, { recursive: true, force: true });
await runThemeProof();
process.stdout.write(
  `${JSON.stringify({
    proof: "tui-first-frame-native-react19",
    sessionSource: "deterministic-frame-fixture",
    react: reactPaths[0],
    verdict: "pass",
    watchCloses: fixture.closeCalls(),
  })}\n`,
);

async function runSessionPickerProof() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const pickerReady = Promise.withResolvers();
  let pickerSetup;
  const pickerCommands = createWhistle();
  let pickerHostOpened = false;
  let pickerResumed = false;
  const pickerChoice = {
    title:
      "Saved native conversation with a very long title that must never overlap the date column",
    createdAt: 1,
    updatedAt: 2,
    resume: async () => {
      pickerResumed = true;
      throw new Error("Picker owner must not resume after Ctrl+C");
    },
  };
  const pickerRunning = runTuiCli(
    { invocationRoot: "/tmp", resume: true },
    {
      prepareClientExtensions: noOpClientExtensions,
      createWhistle: () => pickerCommands,
      loadThemePreference: async () => ({ theme: "mocha" }),
      discoverSessions: async () => ({
        agentCount: 1,
        sessions: [pickerChoice, { ...pickerChoice, title: "", updatedAt: 3 }],
        problems: [],
      }),
      createServiceManager: () => ({
        status: async () => undefined,
        start: async () => ({
          serviceId: "fixture",
          baseUrl: "http://fixture",
        }),
        stop: async () => undefined,
        models: async () => [],
        auth: async () => undefined,
        createSession: async () => {
          pickerHostOpened = true;
          throw new Error("Picker owner must not open after Ctrl+C");
        },
        connect: async () => {
          pickerHostOpened = true;
          throw new Error("Picker owner must not open after Ctrl+C");
        },
        discover: async () => ({
          agentCount: 1,
          sessions: [
            pickerChoice,
            { ...pickerChoice, title: "", updatedAt: 3 },
          ],
          problems: [],
        }),
      }),
      createRenderer: async (options) => {
        pickerSetup = await createTestRenderer({
          ...options,
          height: 10,
          width: 48,
          useKittyKeyboard: null,
        });
        pickerReady.resolve();
        return pickerSetup.renderer;
      },
    },
  );
  try {
    await pickerReady.promise;
    await pickerSetup.renderOnce();
    await waitForFrame(pickerSetup, (frame) =>
      frame.includes("Resume a conversation"),
    );
    const captureDirectory = process.env.TUI_PICKER_CAPTURE_DIR;
    if (captureDirectory) await mkdir(captureDirectory, { recursive: true });
    const captures = [];
    for (const [width, pixels] of [
      [120, 1440],
      [32, 390],
    ]) {
      await act(async () => {
        pickerSetup.resize(width, 24);
        await pickerSetup.renderOnce();
      });
      await waitForFrame(pickerSetup, (frame) => {
        const saved = frame.split("\n").find((line) => line.includes("Saved"));
        return (
          saved?.includes("…") === true &&
          saved.includes(
            new Date(pickerChoice.updatedAt).toLocaleDateString(),
          ) &&
          frame.includes("Untitled")
        );
      });
      const frame = pickerSetup.captureCharFrame();
      const spans = pickerSetup.captureSpans();
      await captureFrame(pickerSetup, captureDirectory, `resume-${pixels}`);
      captures.push({ frame, spans });
    }
    for (const { frame, spans } of captures) {
      const titleLine = spans.lines.find((line) =>
        line.spans.some((span) => span.text.includes("Resume a conversation")),
      );
      assert.ok(titleLine, "resume dialog heading remains visible");
      const headingIndex = titleLine.spans.findIndex((span) =>
        span.text.includes("Resume a conversation"),
      );
      const titleBackgrounds = new Set(
        titleLine.spans
          .slice(Math.max(0, headingIndex - 1), headingIndex + 2)
          .map((span) => JSON.stringify(span.bg.toInts())),
      );
      assert.deepEqual(
        [...titleBackgrounds],
        [JSON.stringify(RGBA.fromHex("#1e1e2e").toInts())],
        "dialog content inherits the host's active Mocha background",
      );
      const lines = frame.split("\n");
      const savedLine = lines.find((line) => line.includes("Saved"));
      assert.ok(
        savedLine?.includes("…"),
        "long session title is one line with an ellipsis",
      );
      const date = new Date(pickerChoice.updatedAt).toLocaleDateString();
      assert.ok(
        savedLine?.includes(date),
        "date stays on the title row without overlap",
      );
      const displayedTitle = savedLine
        .slice(savedLine.indexOf("Saved"), savedLine.indexOf(date))
        .trim();
      assert.ok(
        displayedTitle.endsWith("…"),
        "ellipsis is at the end of the title",
      );
      assert.ok(
        pickerChoice.title.startsWith(displayedTitle.slice(0, -1)),
        "truncation preserves the original title prefix",
      );
      assert.equal((displayedTitle.match(/…/gu) ?? []).length, 1);
      assert.ok(
        !displayedTitle.includes("..."),
        "use the real ellipsis character",
      );
      const untitled = lines.find((line) => line.includes("Untitled"));
      assert.ok(untitled, "empty session titles remain identifiable");
      assert.equal(
        savedLine.indexOf(date),
        untitled.indexOf(new Date(3).toLocaleDateString()),
        "dates share a fixed right-aligned column",
      );
    }
    await pressDecodedKey(pickerSetup, () => {
      pickerSetup.mockInput.pressKey("c", { ctrl: true });
    });
    await boundedCompletion(pickerRunning, "Ctrl+C picker exit");
    assert.equal(pickerHostOpened, false);
    assert.equal(pickerResumed, false);
    assert.equal(pickerSetup.renderer.isDestroyed, true);
  } finally {
    if (!pickerSetup?.renderer.isDestroyed)
      await pickerCommands.execute("tui:exit", { origin: "slash" });
    await pickerRunning;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
}
