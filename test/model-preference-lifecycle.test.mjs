import { setTimeout } from "node:timers";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { useTuiModelSettings } from "@fungi.computer/spore/button/model-query";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { localAccountOwner } from "@fungi.computer/truffle/login";
import { configuredModelAccess } from "./model-access-fixture.js";

const model = {
  providerId: "fixture",
  providerName: "Fixture",
  id: "model",
  name: "Fixture model",
  reasoning: ["low"],
};

test("model query recovery reads the saved preference without reopening the client", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest;
  const errorObserved = Promise.withResolvers();
  const stopObserving = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.state.status === "error") errorObserved.resolve();
  });
  let fail = true;
  let saved = null;
  const preference = {
    providerId: "fixture",
    modelId: "model",
    reasoning: "low",
  };
  const source = {
    identity: "fixture-catalog",
    account: {
      owner: localAccountOwner(
        { auth: async () => configuredModelAccess([model]) },
        () => [],
      ),
      host: "local",
      scope: "user",
      policy: { loginAllowed: () => true },
    },
    effectiveModel: async () => {
      if (fail) throw new Error("temporary effective model failure");
      return {
        agentName: "Shiitake",
        providerId: "fixture",
        providerName: "Fixture",
        modelId: saved?.modelId ?? "model",
        modelName: "Fixture model",
        credential: { kind: "api_key", source: "TEST_API_KEY" },
        label: "Shiitake · Fixture model · TEST_API_KEY",
      };
    },
    models: async () => {
      if (fail) throw new Error("temporary catalog failure");
      return [model];
    },
    modelPreference: {
      read: async () => {
        if (fail) throw new Error("temporary preference failure");
        return saved;
      },
      set: async (value) => {
        saved = value;
      },
    },
  };
  function Projection() {
    const settings = useTuiModelSettings(source);
    latest = settings;
    return createElement(
      "text",
      {},
      settings.error ?? settings.effective?.label ?? "Loading model…",
    );
  }
  const setup = await testRender(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Projection),
    ),
    { width: 64, height: 16, useKittyKeyboard: null },
  );
  try {
    await act(async () => {
      await errorObserved.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => setup.renderOnce());
    assert.match(setup.captureCharFrame(), /temporary catalog failure/u);
    assert.equal(latest.current, undefined);
    fail = false;
    await act(async () => {
      await latest.modelPreference.set(preference);
      await latest.onOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => setup.renderOnce());
    assert.deepEqual(latest.current, preference);
    assert.deepEqual(latest.models, [model]);
    assert.equal(
      latest.effective.label,
      "Shiitake · Fixture model · TEST_API_KEY",
    );
    assert.match(setup.captureCharFrame(), /model/u);
    assert.doesNotMatch(setup.captureCharFrame(), /failure/u);
  } finally {
    await act(async () => setup.renderer.destroy());
    stopObserving();
    queryClient.clear();
  }
});

test("held /new creates once, pins the mounted store, and adopts its connection", async () => {
  const createStarted = Promise.withResolvers();
  const creation = Promise.withResolvers();
  const session = {
    modelPreference: {
      read: async () => null,
      set: async () => undefined,
    },
  };
  const connected = [];
  const closed = [];
  let createCalls = 0;
  let managers = 0;
  let queries = 0;
  let roots = 0;
  let whistles = 0;
  let controls;
  let secondNew;
  let renderCount = 0;
  const connection = (sessionId) => ({
    agentId: "agent-fixture",
    service: { serviceId: "fixture", baseUrl: "http://fixture" },
    databasePath: "/tmp/current-agent.sqlite",
    sessionId: sessionId ?? "session-original",
    client: { close: async () => undefined },
    session,
    close: async () => {
      closed.push(sessionId);
    },
  });
  const service = {
    models: async () => [model],
    connect: async (selection) => {
      connected.push(selection);
      return connection(selection.sessionId);
    },
    createSession: async (selection) => {
      createCalls += 1;
      assert.equal(selection.databasePath, "/tmp/current-agent.sqlite");
      createStarted.resolve();
      await creation.promise;
      return connection("session-fresh");
    },
    discover: async () => ({ sessions: [], problems: [] }),
    status: async () => undefined,
    start: async () => ({ serviceId: "fixture", baseUrl: "http://fixture" }),
    stop: async () => undefined,
  };
  const running = runTuiCli(
    { invocationRoot: "/tmp" },
    {
      prepareClientExtensions: noOpClientExtensions,
      createServiceManager: () => {
        managers += 1;
        return service;
      },
      loadThemePreference: async () => ({ theme: "terminal" }),
      saveThemePreference: async () => undefined,
      renderConnecting: () => undefined,
      createWhistle: () => {
        whistles += 1;
        return createWhistle();
      },
      createQueryClient: () => {
        queries += 1;
        return { clear: () => undefined };
      },
      createRenderer: async () => ({ destroy: () => undefined }),
      createRoot: () => {
        roots += 1;
        return { render: () => undefined, unmount: () => undefined };
      },
      render: (
        _root,
        _query,
        _session,
        _commands,
        onExit,
        _theme,
        nextControls,
      ) => {
        renderCount += 1;
        controls = nextControls;
        if (renderCount === 1) {
          setTimeout(() => {
            void controls.onNew("fixture-pane");
            secondNew = controls.onNew("fixture-pane").catch((cause) => cause);
          }, 0);
        } else {
          onExit();
        }
      },
      enableKeymap: false,
      renderPicker: () => undefined,
      runAuth: async () => undefined,
      runOneShot: async () => undefined,
    },
  );
  await createStarted.promise;
  assert.equal(createCalls, 1);
  assert.deepEqual(
    closed,
    [],
    "creating a peer pane keeps the original client alive",
  );
  assert.match(
    (await secondNew).message,
    /Another Local transition is already pending/u,
  );
  creation.resolve();
  await running;
  assert.deepEqual(closed, ["session-fresh", undefined]);
  assert.deepEqual(
    { managers, queries, roots, whistles },
    { managers: 1, queries: 1, roots: 1, whistles: 1 },
  );
  assert.deepEqual(
    connected.map((selection) => selection.sessionId),
    [undefined],
  );
  assert.deepEqual(
    connected.map((selection) => selection.databasePath),
    [undefined],
  );
});
