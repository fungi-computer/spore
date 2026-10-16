import { createWhistle } from "@fungi.computer/whistle";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";

import { SessionPicker } from "@fungi.computer/spore/session-picker";
import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

const serviceManager = {
  models: async () => [],
  connect: async () => {
    throw new Error("Unexpected default connection in picker test");
  },
};

const sessions = [
  {
    title: "Repair the local host",
    createdAt: 1,
    updatedAt: 2,
    resume: async () => ({
      agentId: "agent-fixture",
      sessionId: "session-fixture",
      databasePath: "/private/not-rendered.sqlite",
      session: {},
      close: async () => undefined,
    }),
  },
];

test("renders a maintained resume chooser and selects an existing store", async () => {
  let selected;
  const setup = await testRender(
    createElement(SessionPicker, {
      sessions,
      onCancel: () => undefined,
      onSelect: (index) => {
        selected = index;
      },
    }),
    { width: 48, height: 8, useKittyKeyboard: null },
  );
  try {
    await act(async () => setup.renderOnce());
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(setup.captureCharFrame(), /Repair the local host/u);
    await act(async () => setup.mockInput.pressEnter());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(selected, 0);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("cancels before opening a selected host", async () => {
  let hostOpened = false;
  let unmounted = 0;
  let destroyed = 0;
  const renderer = {
    destroy: () => {
      destroyed += 1;
    },
  };
  const root = {
    render: () => undefined,
    unmount: () => {
      unmounted += 1;
    },
  };
  await runTuiCli(
    { invocationRoot: "/tmp", resume: true },
    {
      discoverSessions: async () => ({ agentCount: 1, sessions, problems: [] }),
      createRenderer: async () => renderer,
      createRoot: () => root,
      renderPicker: (_root, _sessions, _onSelect, onCancel) => onCancel(),
      createServiceManager: () => ({
        ...serviceManager,
        connect: async () => {
          hostOpened = true;
          throw new Error("host must not open after cancellation");
        },
      }),
      prepareClientExtensions: noOpClientExtensions,
    },
  );
  assert.equal(hostOpened, false);
  assert.equal(unmounted, 1);
  assert.equal(destroyed, 1);
});

test("the maintained renderer key handler cancels the focused chooser", async () => {
  let cancelled = false;
  const setup = await testRender(
    createElement(SessionPicker, {
      sessions,
      onCancel: () => {
        cancelled = true;
      },
      onSelect: () => undefined,
    }),
    { width: 48, height: 8, useKittyKeyboard: null },
  );
  try {
    await act(async () => setup.renderOnce());
    await new Promise((resolve) => setImmediate(resolve));
    await act(async () => {
      setup.mockInput.pressEscape();
      await delay(25);
    });
    assert.equal(cancelled, true);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("--last opens the newest discovered store without a picker", async () => {
  let resumed = false;
  const resumedHost = {
    agentId: "agent-fixture",
    sessionId: "session-fixture",
    databasePath: "/tmp/newest.sqlite",
    session: {},
    close: async () => undefined,
  };
  const lastSessions = [
    {
      ...sessions[0],
      resume: async () => {
        resumed = true;
        return resumedHost;
      },
    },
  ];
  await runTuiCli(
    { invocationRoot: "/tmp", resume: true, last: true },
    {
      createServiceManager: () => serviceManager,
      prepareClientExtensions: noOpClientExtensions,
      discoverSessions: async () => ({ sessions: lastSessions, problems: [] }),
      createWhistle,
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({ destroy: () => undefined }),
      createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      renderConnecting: () => undefined,
      render: (_root, _query, _session, _commands, onExit) => onExit(),
    },
  );
  assert.equal(resumed, true);
});

test("picker selection reopens its hidden existing database target", async () => {
  let pickerRendered = false;
  let resumed = false;
  const host = {
    agentId: "agent-fixture",
    sessionId: "session-fixture",
    databasePath: "/tmp/picked.sqlite",
    session: {},
    close: async () => undefined,
  };
  const pickerSessions = [
    {
      ...sessions[0],
      resume: async () => {
        resumed = true;
        return host;
      },
    },
  ];
  await runTuiCli(
    { invocationRoot: "/tmp", resume: true },
    {
      createServiceManager: () => serviceManager,
      prepareClientExtensions: noOpClientExtensions,
      discoverSessions: async () => ({
        sessions: pickerSessions,
        problems: [],
      }),
      createWhistle,
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({ destroy: () => undefined }),
      createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      renderConnecting: () => undefined,
      renderPicker: (_root, _sessions, onSelect) => {
        pickerRendered = true;
        onSelect(0);
      },
      render: (_root, _query, _session, _commands, onExit) => onExit(),
    },
  );
  assert.equal(pickerRendered, true);
  assert.equal(resumed, true);
});

test("ordinary startup shows the conversation chooser for multiple Agent stores", async () => {
  let chooser = false;
  let connections = 0;
  await runTuiCli(
    { invocationRoot: "/tmp" },
    {
      loadThemePreference: async () => ({ theme: "terminal" }),
      createServiceManager: () => ({
        ...serviceManager,
        discover: async () => ({ agentCount: 2, sessions, problems: [] }),
        connect: async () => {
          connections += 1;
          throw new Error("must not choose an Agent");
        },
      }),
      prepareClientExtensions: noOpClientExtensions,
      createRenderer: async () => ({ destroy: () => undefined }),
      createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      renderPicker: (_root, choices, _select, cancel) => {
        chooser = true;
        assert.equal(choices, sessions);
        cancel();
      },
    },
  );
  assert.equal(chooser, true);
  assert.equal(connections, 0);
});
