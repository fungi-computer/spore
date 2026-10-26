import * as Effect from "effect/Effect";
import { EventEmitter } from "node:events";
import { setTimeout } from "node:timers";
import { createWhistle } from "@fungi.computer/whistle";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { LocalServiceUpdated } from "@fungi.computer/truffle/service";
import { liveServiceStatusSchema } from "../../../runtimes/local/src/private-local-service-discovery.js";
import { localServiceIds } from "../../../runtimes/local/src/private-local-service-ids.js";

test("external renderer destruction closes the client without destroying twice", async () => {
  let destroys = 0;
  let closes = 0;
  let options;
  const renderer = {
    isDestroyed: false,
    destroy() {
      destroys++;
      if (this.isDestroyed) throw Error("renderer already destroyed");
      this.isDestroyed = true;
      options.onDestroy();
    },
  };
  await runTuiCli(
    { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
    {
      createServiceManager: () => ({
        connect: async () => ({
          sandboxStatus: async () => ({
            mode: "full-access",
            available: true,
          }),
          agentId: "agent-fixture",
          sessionId: "session-fixture",
          databasePath: "/fixture/agent.sqlite",
          session: { modelPreference: { read: async () => null } },
          close: async () => {
            closes++;
          },
        }),
        models: async () => [],
      }),
      loadThemePreference: async () => ({ theme: "terminal" }),
      renderConnecting: () => undefined,
      createWhistle,
      createQueryClient: () => ({
        clear() {
          return undefined;
        },
      }),
      createRenderer: async (value) => {
        options = value;
        return renderer;
      },
      createRoot: () => ({
        unmount() {
          return undefined;
        },
      }),
      enableKeymap: false,
      render: () => renderer.destroy(),
    },
  );
  assert.equal(destroys, 1);
  assert.equal(closes, 1);
});

for (const signal of ["SIGHUP", "SIGTERM"]) {
  test(`${signal} releases the mounted client and removes its signal handler`, async () => {
    const signals = new EventEmitter();
    let closes = 0;
    let destroys = 0;
    await runTuiCli(
      { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
      {
        signals,
        createServiceManager: () => ({
          connect: async () => ({
            sandboxStatus: async () => ({
              mode: "full-access",
              available: true,
            }),
            agentId: "agent-fixture",
            sessionId: "session-fixture",
            databasePath: "/fixture/agent.sqlite",
            session: { modelPreference: { read: async () => null } },
            close: async () => {
              closes++;
            },
          }),
          models: async () => [],
        }),
        loadThemePreference: async () => ({ theme: "terminal" }),
        renderConnecting: () => undefined,
        createWhistle,
        createQueryClient: () => ({
          clear() {
            return undefined;
          },
        }),
        createRenderer: async () => ({
          isDestroyed: false,
          destroy() {
            this.isDestroyed = true;
            destroys++;
          },
        }),
        createRoot: () => ({
          unmount() {
            return undefined;
          },
        }),
        enableKeymap: false,
        render: () => {
          assert.equal(signals.listenerCount(signal), 1);
          signals.emit(signal);
        },
      },
    );
    assert.equal(closes, 1);
    assert.equal(destroys, 1);
    assert.equal(signals.listenerCount(signal), 0);
  });
}

test("exit can interrupt held theme startup before connecting a client", async () => {
  const themeRead = Promise.withResolvers();
  const themeStarted = Promise.withResolvers();
  const commands = createWhistle();
  let destroyed = false;
  let rendererOptions;
  let connects = 0;
  const renderer = {
    destroy() {
      destroyed = true;
      rendererOptions.onDestroy();
    },
  };
  const running = runTuiCli(
    { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
    {
      loadThemePreference: () => {
        themeStarted.resolve();
        return themeRead.promise;
      },
      createServiceManager: () => ({
        connect: async () => {
          connects += 1;
          throw new Error("connect must not run after exit");
        },
      }),
      prepareClientExtensions: () =>
        Effect.succeed({
          entries: Effect.succeed([]),
          attach: () => Effect.void,
        }),
      createWhistle: () => commands,
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async (options) => {
        rendererOptions = options;
        return renderer;
      },
      createRoot: () => ({ unmount: () => undefined }),
      renderConnecting: () => undefined,
      enableKeymap: false,
    },
  );
  await themeStarted.promise;
  await commands.execute("tui:ctrl-c", { origin: "keyboard" });
  await running;
  themeRead.resolve({ theme: "terminal" });
  await Promise.resolve();
  assert.equal(connects, 0);
  assert.equal(destroyed, true);
});

test("rejected theme preference reaches the mounted frame as a visible error", async () => {
  const rendered = Promise.withResolvers();
  const running = runTuiCli(
    { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
    {
      loadThemePreference: async () => {
        throw new Error("theme read failed");
      },
      createServiceManager: () => ({
        connect: async () => ({
          sandboxStatus: async () => ({
            mode: "full-access",
            available: true,
          }),
          agentId: "agent-fixture",
          sessionId: "session-fixture",
          databasePath: "/fixture/agent.sqlite",
          session: {
            address: "fixture://session",
            modelPreference: { read: async () => null },
          },
          close: async () => undefined,
        }),
      }),
      prepareClientExtensions: () =>
        Effect.succeed({
          entries: Effect.succeed([]),
          attach: () => Effect.void,
        }),
      createWhistle,
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({ destroy: () => undefined }),
      createRoot: () => ({ unmount: () => undefined }),
      renderConnecting: () => undefined,
      enableKeymap: false,
      render: (_root, _query, _session, _commands, onExit, theme) => {
        rendered.resolve(theme.themeError);
        onExit();
      },
    },
  );
  assert.equal(await rendered.promise, "theme read failed");
  await running;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function applicationFixture(
  service,
  onRender = () => undefined,
  onRecovery = () => undefined,
  openClientExtensions = () => undefined,
  renderPicker = (_root, _sessions, _onSelect, cancel) => cancel(),
) {
  const commands = createWhistle();
  const mounted = Promise.withResolvers();
  let controls;
  let exit;
  let destroyed = false;
  let renders = 0;
  const running = runTuiCli(
    { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
    {
      createServiceManager: () => service,
      createWhistle: () => commands,
      loadThemePreference: async () => ({ theme: "terminal" }),
      prepareClientExtensions: () =>
        Effect.succeed({
          entries: Effect.succeed([]),
          attach: (session) =>
            Effect.acquireRelease(
              Effect.sync(() => openClientExtensions(session)),
              (attachment) =>
                Effect.promise(() => attachment?.close() ?? Promise.resolve()),
            ).pipe(Effect.asVoid),
        }),
      createRenderer: async () => ({
        destroy() {
          destroyed = true;
        },
      }),
      createRoot: () => ({
        render() {
          return undefined;
        },
        unmount() {
          return undefined;
        },
      }),
      renderConnecting: () => undefined,
      renderRecovery: (_root, error, retry, exit) =>
        onRecovery(error, retry, exit),
      enableKeymap: false,
      renderPicker,
      render: (_root, _query, _session, _commands, onExit, _theme, next) => {
        onRender(_session);
        controls = next;
        exit = onExit;
        renders++;
        mounted.resolve();
      },
    },
  );
  return {
    commands,
    running,
    mounted: mounted.promise,
    get controls() {
      return controls;
    },
    get destroyed() {
      return destroyed;
    },
    get renders() {
      return renders;
    },
    exit: () => exit(),
  };
}

function selectedClient(closed, id) {
  return {
    sandboxStatus: async () => ({
      mode: "full-access",
      available: true,
    }),
    agentId: "agent-fixture",
    sessionId: id,
    databasePath: "/fixture/agent.sqlite",
    session: {
      address: `fixture://${id}`,
      modelPreference: { read: async () => null, set: async () => undefined },
    },
    close: async () => {
      closed.push(id);
    },
  };
}

test("a pane connect that meets a replaced protocol shows only the restart message and waits for exit", async () => {
  const notices = [];
  const recoveries = [];
  let connects = 0;
  await runTuiCli(
    { invocationRoot: "/fixture", sessionId: "saved" },
    {
      createServiceManager: () => ({
        connect: async () => {
          connects++;
          throw new LocalServiceUpdated();
        },
      }),
      loadThemePreference: async () => ({ theme: "terminal" }),
      prepareClientExtensions: () =>
        Effect.succeed({
          entries: Effect.succeed([]),
          attach: () => Effect.void,
        }),
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({ destroy: () => undefined }),
      createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      renderConnecting: () => undefined,
      renderRecovery: (_root, error, _retry, exit) => {
        recoveries.push(error.message);
        exit();
      },
      renderServiceUpdated: (_root, message, exit) => {
        notices.push(message);
        setTimeout(exit, 20);
      },
      enableKeymap: false,
    },
  );
  assert.equal(connects, 1);
  assert.deepEqual(notices, [
    "The Fungi service was updated. Restart this window.",
  ]);
  assert.deepEqual(recoveries, []);
});

test("an unavailable stream on the same protocol keeps ordinary reconnect available", async () => {
  let restartMessages = 0;
  let reconnectHandled;
  // Decode eagerly so reconnect's error boundary cannot swallow a stale shape.
  const serviceStatus = liveServiceStatusSchema.parse({
    protocol: 4,
    version: "b".repeat(64),
    serviceId: localServiceIds.service.generate(),
    pid: 1,
    baseUrl: "http://127.0.0.1:1234",
    startedAt: "fixture-process-start",
    diagnostics: { state: "active" },
  });
  await runTuiCli(
    { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
    {
      createServiceManager: () => ({
        connect: async () => selectedClient([], "session-123"),
        status: async () => serviceStatus,
      }),
      createWhistle,
      loadThemePreference: async () => ({ theme: "terminal" }),
      prepareClientExtensions: () =>
        Effect.succeed({
          entries: Effect.succeed([]),
          attach: () => Effect.void,
        }),
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({ destroy: () => undefined }),
      createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      renderConnecting: () => undefined,
      renderServiceUpdated: () => {
        restartMessages++;
      },
      enableKeymap: false,
      render: (_root, _query, _session, _commands, exit, _theme, controls) => {
        void controls.onObservationUnavailable().then((handled) => {
          reconnectHandled = handled;
          exit();
        });
      },
    },
  );
  assert.equal(restartMessages, 0);
  assert.equal(reconnectHandled, false);
});

test("extension cleanup failure preserves selected client cleanup", async () => {
  const failure = new Error("extension cleanup failed");
  const closed = [];
  const app = applicationFixture(
    { connect: async () => selectedClient(closed, "selected") },
    undefined,
    undefined,
    () => ({
      close: async () => {
        throw failure;
      },
    }),
  );
  await app.mounted;
  app.exit();
  await assert.rejects(app.running, (cause) => {
    if (cause === failure) return true;
    assert(cause instanceof AggregateError);
    assert(cause.errors.includes(failure));
    return true;
  });
  assert.deepEqual(closed, ["selected"]);
});

test("opening a peer retains both reporters until their own views close", async () => {
  const attached = Promise.withResolvers();
  const releasing = Promise.withResolvers();
  const released = Promise.withResolvers();
  const events = [];
  const closed = [];
  const app = applicationFixture(
    {
      connect: async () => selectedClient(closed, "original"),
      createSession: async () => selectedClient(closed, "replacement"),
    },
    () => undefined,
    () => undefined,
    (session) => {
      events.push(`attach ${session.address}`);
      attached.resolve();
      return {
        close: async () => {
          if (session.address === "fixture://original") {
            releasing.resolve();
            await released.promise;
          }
          events.push(`release ${session.address}`);
        },
      };
    },
  );
  let closing;
  try {
    await attached.promise;
    await tick();
    const original = app.controls;
    await original.onNew();
    assert.equal(app.renders, 2);
    assert.deepEqual(
      closed,
      [],
      "opening another pane never closes the original client",
    );
    assert.deepEqual(events, [
      "attach fixture://original",
      "attach fixture://replacement",
    ]);
    closing = original.onClose();
    await releasing.promise;
    assert.equal(app.renders, 2, "reporter release does not remount its peer");
    released.resolve();
    await closing;
    assert.deepEqual(events, [
      "attach fixture://original",
      "attach fixture://replacement",
      "release fixture://original",
    ]);
  } finally {
    released.resolve();
    await closing;
    app.exit();
    await app.running;
  }
  assert.deepEqual(closed, ["original", "replacement"]);
  assert.equal(events.at(-1), "release fixture://replacement");
});

test("the workspace Open action starts a conversation in the live pane's Agent after the first pane closed", async () => {
  const closed = [];
  const databasePaths = [];
  const app = applicationFixture(
    {
      connect: async () => selectedClient(closed, "original"),
      createSession: async (creation) => {
        databasePaths.push(creation.databasePath);
        return {
          ...selectedClient(closed, `created-${databasePaths.length}`),
          databasePath: "/fixture/agent-b.sqlite",
        };
      },
    },
    () => undefined,
    () => undefined,
    () => ({ close: async () => undefined }),
  );
  try {
    await tick();
    const original = app.controls;
    await original.onNew();
    assert.equal(app.renders, 2);
    await original.onClose();
    // The frame keeps the first render's workspace configuration.
    const placement = { direction: "below", afterPaneId: "focused-pane" };
    await original.openConversation(placement);
    assert.equal(app.renders, 3, "Open > New conversation rendered a pane");
    assert.deepEqual(app.controls.openPlacement, placement);
    await app.controls.openConversation();
    assert.equal(app.controls.openPlacement, undefined);
    assert.deepEqual(databasePaths, [
      "/fixture/agent.sqlite",
      "/fixture/agent-b.sqlite",
      "/fixture/agent-b.sqlite",
    ]);
  } finally {
    app.exit();
    await app.running;
  }
});

test("workspace resume carries placement through selection to admission", async () => {
  const closed = [];
  const app = applicationFixture(
    {
      connect: async () => selectedClient(closed, "original"),
      discover: async () => ({
        agents: [
          {
            agentId: "one",
            databasePath: "/project/one/agent.sqlite",
            sessionCount: 1,
          },
        ],
        problems: [],
        sessions: [
          {
            title: "saved",
            updatedAt: 0,
            resume: async () => selectedClient(closed, "resumed"),
          },
        ],
      }),
    },
    () => undefined,
    () => undefined,
    () => undefined,
    (_root, _sessions, select) => select(0),
  );
  try {
    await app.mounted;
    await tick();
    const placement = { direction: "beside", afterPaneId: "focused-pane" };
    await app.controls.chooseConversation(placement);
    assert.equal(app.renders, 2);
    assert.deepEqual(app.controls.openPlacement, placement);
    assert.deepEqual(closed, []);
  } finally {
    app.exit();
    await app.running;
  }
});

test("failed placed creation cannot place a later ordinary conversation", async () => {
  const closed = [];
  let attempts = 0;
  const app = applicationFixture({
    connect: async () => selectedClient(closed, "original"),
    createSession: async () => {
      if (++attempts === 1) throw Error("creation unavailable");
      return selectedClient(closed, "ordinary");
    },
  });
  try {
    await app.mounted;
    await tick();
    await assert.rejects(
      app.controls.openConversation({
        direction: "below",
        afterPaneId: "focused-pane",
      }),
      /creation unavailable/u,
    );
    await app.controls.openConversation();
    assert.equal(attempts, 2);
    assert.equal(app.renders, 2);
    assert.equal(app.controls.openPlacement, undefined);
  } finally {
    app.exit();
    await app.running;
  }
});

test("local Ctrl+C is admitted before service connection and never stops the service", async () => {
  const connecting = Promise.withResolvers();
  let stops = 0;
  const app = applicationFixture({
    connect: (_selection, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        connecting.resolve();
      }),
    stop: async () => {
      stops++;
    },
  });
  await connecting.promise;
  const outcome = await app.commands.execute("tui:ctrl-c", {
    origin: "keyboard",
  });
  await app.running;
  assert.equal(outcome.status, "handled");
  assert.equal(app.destroyed, true);
  assert.equal(stops, 0);
});

test("cancelled resume and rejected replacement retain the current client", async () => {
  const closed = [];
  const createRequestIds = [];
  const app = applicationFixture({
    connect: async () => selectedClient(closed, "original"),
    discover: async () => ({
      agents: [
        {
          agentId: "one",
          databasePath: "/project/one/agent.sqlite",
          sessionCount: 1,
        },
      ],
      problems: [],
      sessions: [
        {
          title: "other",
          updatedAt: 0,
          resume: async () => {
            throw Error("cancel must not open");
          },
        },
      ],
    }),
    createSession: async (creation) => {
      createRequestIds.push(creation.requestId);
      throw Error("replacement unavailable");
    },
  });
  try {
    await app.mounted;
    await tick();
    await app.controls.onResume("fixture-pane");
    await app.controls.chooseConversation({
      direction: "beside",
      afterPaneId: "fixture-pane",
    });
    assert.equal(app.controls.openPlacement, undefined);
    assert.deepEqual(closed, []);
    await assert.rejects(
      app.controls.onNew("fixture-pane"),
      /replacement unavailable/u,
    );
    await assert.rejects(
      app.controls.onNew("fixture-pane"),
      /replacement unavailable/u,
    );
    assert.equal(createRequestIds.length, 2);
    assert.ok(createRequestIds[0]);
    assert.equal(createRequestIds[1], createRequestIds[0]);
    assert.deepEqual(closed, []);
    assert.equal(app.renders, 1);
  } finally {
    app.exit();
    await app.running;
  }
  assert.deepEqual(closed, ["original"]);
});

test("a pane's retried new Session reuses its create-request key", async () => {
  const closed = [];
  const createRequestIds = [];
  const app = applicationFixture({
    connect: async () => selectedClient(closed, "original"),
    createSession: async (creation) => {
      createRequestIds.push(creation.requestId);
      throw Error("Local service transport closed");
    },
  });
  try {
    await app.mounted;
    await tick();
    const target = {
      agentId: "agent-fixture",
      sessionId: null,
      createRequestId: "request_pane-new",
    };
    const signal = new globalThis.AbortController().signal;
    await assert.rejects(
      app.controls.acquireSession(target, signal),
      /transport closed/u,
    );
    await assert.rejects(
      app.controls.acquireSession(target, signal),
      /transport closed/u,
    );
    assert.deepEqual(createRequestIds, [
      "request_pane-new",
      "request_pane-new",
    ]);
    assert.deepEqual(closed, []);
  } finally {
    app.exit();
    await app.running;
  }
  assert.deepEqual(closed, ["original"]);
});

test("exit restores terminal before held replacement settles and closes the late client", async () => {
  const opening = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const closed = [];
  const app = applicationFixture({
    connect: async () => selectedClient(closed, "original"),
    createSession: async () => {
      entered.resolve();
      return opening.promise;
    },
  });
  await app.mounted;
  await tick();
  const replacement = app.controls.onNew("fixture-pane");
  await entered.promise;
  app.exit();
  await tick();
  assert.equal(app.destroyed, true);
  assert.equal(app.renders, 1);
  opening.resolve(selectedClient(closed, "late"));
  await replacement;
  await app.running;
  assert.deepEqual(closed, ["late", "original"]);
  assert.equal(app.renders, 1);
});

test("failed replacement preserves both render and cleanup causes and the original client", async () => {
  const closed = [];
  const renderFailure = new Error("replacement render failed");
  const closeFailure = new Error("replacement close failed");
  const app = applicationFixture(
    {
      connect: async () => selectedClient(closed, "original"),
      createSession: async () => ({
        ...selectedClient(closed, "replacement"),
        close: async () => {
          throw closeFailure;
        },
      }),
    },
    (session) => {
      if (session.address === "fixture://replacement") throw renderFailure;
    },
  );
  try {
    await app.mounted;
    await tick();
    await assert.rejects(app.controls.onNew("fixture-pane"), (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [renderFailure, closeFailure]);
      return true;
    });
    assert.equal(app.destroyed, false);
    assert.equal(app.renders, 1);
    assert.deepEqual(closed, []);
  } finally {
    app.exit();
    await app.running;
  }
  assert.deepEqual(closed, ["original"]);
});

test("failed startup retains terminal and retries without stopping the service", async () => {
  const failed = Promise.withResolvers();
  const closed = [];
  const original = new Error("service unavailable");
  let attempts = 0;
  let retry;
  const app = applicationFixture(
    {
      connect: async () => {
        if (++attempts === 1) throw original;
        return selectedClient(closed, "recovered");
      },
      stop: () => {
        throw new Error("client must not stop service");
      },
    },
    () => undefined,
    (error, again) => {
      assert.equal(error, original);
      retry = again;
      failed.resolve();
    },
  );
  await failed.promise;
  assert.equal(app.destroyed, false);
  assert.equal(attempts, 1);
  retry();
  retry();
  await app.mounted;
  assert.equal(attempts, 2);
  assert.equal(app.renders, 1);
  app.exit();
  await app.running;
  assert.deepEqual(closed, ["recovered"]);
});

test("Ctrl+C exits failed startup without retry or a selected client", async () => {
  const failed = Promise.withResolvers();
  let attempts = 0;
  const app = applicationFixture(
    {
      connect: async () => {
        attempts++;
        throw new Error("unavailable");
      },
    },
    () => undefined,
    () => failed.resolve(),
  );
  await failed.promise;
  await app.commands.execute("tui:ctrl-c", { origin: "keyboard" });
  await app.running;
  assert.equal(app.destroyed, true);
  assert.equal(attempts, 1);
});
