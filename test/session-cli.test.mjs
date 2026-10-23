import { executeAlias, waitForCommandGraph } from "./command-selection.js";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawn } from "bun";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout, setImmediate } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { InputRenderable, KeyEvent, TextareaRenderable } from "@opentui/core";
import { createWhistle } from "@fungi.computer/whistle";
import { act } from "react";
import {
  defaultScheduler,
  notifyManager,
  QueryObserver,
} from "@tanstack/query-core";
import { createQueryClient } from "@fungi.computer/agar/query";
import { sessionQueryOptions } from "@fungi.computer/parakeet/headless";

import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { renderTuiConversation } from "@fungi.computer/spore/frame-renderer";
import { runFungiCli } from "../src/cli.js";
import { runPrivateLocalWorkerServer } from "@fungi.computer/truffle/service";
import { createTuiFixture, fixtureGoalStartedAt } from "./fixture.js";
import {
  loadThemePreference,
  saveThemePreference,
} from "@fungi.computer/spore/button/theme-preferences";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { configuredModelAccess } from "./model-access-fixture.js";
import { waitForFrame } from "./native-readiness.js";
import { enterReactActEnvironment } from "./native-renderer-cleanup.js";

async function pressDecodedKey(setup, press) {
  const decoded = Promise.withResolvers();
  const handler = (event) => decoded.resolve(event);
  // Observe decoding before the keymap consumes the event; assertions below
  // still verify the command's effect on the mounted frame.
  setup.renderer.keyInput.prependListener("keypress", handler);
  const timeout = setTimeout(
    () => decoded.reject(new Error("Key was not decoded")),
    2000,
  );
  try {
    await act(async () => {
      press();
      await decoded.promise;
    });
    await act(async () => setup.renderOnce());
  } finally {
    clearTimeout(timeout);
    setup.renderer.keyInput.off("keypress", handler);
  }
}

async function pressEscape(setup) {
  await pressDecodedKey(setup, () => setup.mockInput.pressEscape());
}

const source = fileURLToPath(new URL("../src/cli.tsx", import.meta.url));

const choice = (resume) => ({
  databasePath: "/private/hidden.sqlite",
  title: "Saved conversation",
  createdAt: 1,
  updatedAt: 2,
  resume,
});

const host = {
  sandboxStatus: async () => ({
    state: "available",
    requireSandbox: false,
  }),
  agentId: "agent-fixture",
  sessionId: "session-fixture",
  databasePath: "/private/hidden.sqlite",
  session: {},
  close: async () => undefined,
};
function dependencies(discovery, overrides = {}) {
  return {
    discoverSessions: async () => discovery,
    prepareClientExtensions: noOpClientExtensions,
    createWhistle,
    createQueryClient: () => ({ clear: () => undefined }),
    createRenderer: async () => ({ destroy: () => undefined }),
    createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
    renderConnecting: () => undefined,
    render: (_root, _query, _session, _commands, onExit) => onExit(),
    ...overrides,
  };
}

async function withStderrCapture(action) {
  let output = "";
  const original = globalThis.process.stderr.write;
  globalThis.process.stderr.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    await action();
  } finally {
    globalThis.process.stderr.write = original;
  }
  return output;
}

// Includes cold native module startup; the retained installed-entrypoint proof uses 30s.
test("the Bun entrypoint dispatches invalid grammar through a package symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-cli-entry-"));
  const entrypoint = join(directory, "cli.tsx");
  try {
    await symlink(source, entrypoint);
    const child = spawn([process.execPath, entrypoint, "bogus"], {
      cwd: process.cwd(),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new globalThis.Response(child.stdout).text(),
      new globalThis.Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(exitCode, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /Unknown fungi command: bogus/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("serve rejects client and owner overrides before reading workers", async () => {
  await assert.rejects(
    runFungiCli([
      "serve",
      "--workers",
      "/does-not-exist/workers.json",
      "--listen",
      "http://127.0.0.1:43123",
      "--model",
      "gpt-5.6-sol",
    ]),
    /fungi serve cannot be combined with client or local owner options/u,
  );
});

test("serve remains alive until a signal and closes its batch once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-cli-serve-"));
  try {
    await writeFile(
      join(directory, "workers.json"),
      JSON.stringify([
        {
          name: "alpha",
          owner: { invocationRoot: "./alpha", databasePath: "./alpha.sqlite" },
        },
      ]),
    );
    const signals = new EventEmitter();
    const output = [];
    const ready = Promise.withResolvers();
    let opened;
    let closes = 0;
    const running = runPrivateLocalWorkerServer(
      "workers.json",
      "http://127.0.0.1:43123",
      {
        cwd: directory,
        stdout: {
          write: (chunk) => {
            output.push(String(chunk));
            ready.resolve();
          },
        },
        signals,
      },
      async (workers, listen) => {
        opened = { workers, listen };
        return {
          baseUrl: "http://127.0.0.1:43123",
          workers: [
            {
              name: "alpha",
              routePath: "/workers/alpha",
              databasePath: "/tmp/alpha.sqlite",
            },
          ],
          close: async () => {
            closes += 1;
          },
        };
      },
    );
    await Promise.race([ready.promise, running]);
    assert.deepEqual(opened, {
      workers: [
        {
          name: "alpha",
          owner: {
            invocationRoot: join(directory, "alpha"),
            databasePath: "./alpha.sqlite",
            configRoot: {
              home: process.env.HOME,
              credentialPath: join(
                process.env.HOME,
                ".config",
                "fungi",
                "credentials.json",
              ),
              serviceDirectory: join(process.env.HOME, ".fungi", "service"),
            },
          },
        },
      ],
      listen: "http://127.0.0.1:43123",
    });
    assert.match(output.join(""), /"status":"ready"/u);
    assert.equal(closes, 0);

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await running;
    assert.equal(closes, 1);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serve defers an opening signal until the batch is acquired", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-cli-serve-opening-"));
  try {
    const workersFile = join(directory, "workers.json");
    await writeFile(
      workersFile,
      JSON.stringify([{ name: "alpha", owner: { invocationRoot: "." } }]),
    );
    const signals = new EventEmitter();
    const output = [];
    const opening = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let openCalls = 0;
    let closeCalls = 0;
    const running = runPrivateLocalWorkerServer(
      workersFile,
      "http://127.0.0.1:43123",
      {
        cwd: directory,
        stdout: { write: (chunk) => output.push(String(chunk)) },
        signals,
      },
      async () => {
        openCalls += 1;
        entered.resolve();
        return opening.promise;
      },
    );
    await entered.promise;
    assert.equal(openCalls, 1);
    signals.emit("SIGINT");
    opening.resolve({
      baseUrl: "http://127.0.0.1:43123",
      workers: [],
      close: async () => {
        closeCalls += 1;
      },
    });
    await running;
    assert.equal(closeCalls, 1);
    assert.deepEqual(output, []);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serve removes signal handlers when opening rejects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-cli-serve-reject-"));
  try {
    const workersFile = join(directory, "workers.json");
    await writeFile(
      workersFile,
      JSON.stringify([{ name: "alpha", owner: { invocationRoot: "." } }]),
    );
    const signals = new EventEmitter();
    const openingFailure = new Error("worker opening failed");
    const running = runPrivateLocalWorkerServer(
      workersFile,
      "http://127.0.0.1:43123",
      { cwd: directory, signals },
      async () => {
        await delay(0);
        throw openingFailure;
      },
    );
    await assert.rejects(running, (cause) => cause === openingFailure);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serve preserves ready-output and close failures while cleaning signals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-cli-serve-failure-"));
  try {
    await writeFile(
      join(directory, "workers.json"),
      JSON.stringify([{ name: "alpha", owner: { invocationRoot: "." } }]),
    );
    const signals = new EventEmitter();
    let closes = 0;
    const running = runPrivateLocalWorkerServer(
      "workers.json",
      "http://127.0.0.1:43123",
      {
        cwd: directory,
        stdout: {
          write: () => {
            throw new Error("ready output failed");
          },
        },
        signals,
      },
      async () => ({
        baseUrl: "http://127.0.0.1:43123",
        workers: [],
        close: async () => {
          closes += 1;
          throw new Error("batch close failed");
        },
      }),
    );
    await assert.rejects(
      running,
      (cause) =>
        cause instanceof AggregateError &&
        cause.message === "Worker server startup and close failed" &&
        cause.errors.some((error) =>
          /ready output failed/u.test(error.message),
        ) &&
        cause.errors.some((error) => /batch close failed/u.test(error.message)),
    );
    assert.equal(closes, 1);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty resume is distinct from corrupt, unreadable, and in-use stores", async () => {
  for (const [problems, expected] of [
    [[], /No saved conversations in this folder/u],
    [
      [{ kind: "corrupt" }, { kind: "unreadable" }, { kind: "in_use" }],
      /Skipped 3 saved conversations \(1 corrupt, 1 in_use, 1 unreadable\)/u,
    ],
  ]) {
    let shown;
    const output = await withStderrCapture(() =>
      runTuiCli(
        { invocationRoot: "/tmp", resume: true },
        dependencies(
          { sessions: [], problems },
          {
            createServiceManager: () => ({
              connect: async () => {
                throw new Error("host must not open");
              },
            }),
            renderRecovery: (_root, error, _retry, exit) => {
              shown = error.message;
              exit();
            },
          },
        ),
      ),
    );
    assert.match(shown, expected);
    assert.equal(
      output,
      "",
      "discovery failures do not write over the terminal",
    );
  }
});

test("mixed resume reports skipped stores while opening the healthy latest store", async () => {
  let resumed = false;
  const healthy = choice(async () => {
    resumed = true;
    return host;
  });
  let pickerRendered = false;
  let notice;
  const output = await withStderrCapture(() =>
    runTuiCli(
      { invocationRoot: "/tmp", resume: true, last: true },
      dependencies(
        { sessions: [healthy], problems: [{ kind: "corrupt" }] },
        {
          renderPicker: () => {
            pickerRendered = true;
          },
          render: (
            _root,
            _query,
            _session,
            _commands,
            onExit,
            _theme,
            controls,
          ) => {
            notice = controls.initialCommandNotice;
            onExit();
          },
        },
      ),
    ),
  );
  assert.equal(resumed, true);
  assert.equal(pickerRendered, false);
  assert.match(notice, /Skipped 1 saved conversation \(1 corrupt\)/u);
  assert.equal(output, "");
});

test("sessions list and resume by number, ID, or unique prefix use the same discovery choices as the picker", async () => {
  let output = "";
  let resumed = 0;
  let latestResumed = 0;
  const saved = [
    {
      ...choice(async () => {
        latestResumed += 1;
        return host;
      }),
      sessionId: "recent",
      title: "Recent\u001b]52;c;Y21k\u0007\u009d\u0090\u202e work",
    },
    {
      ...choice(async () => {
        resumed += 1;
        return host;
      }),
      sessionId: "older",
      title: "Older work",
    },
  ];
  let discoveries = 0;
  const manager = {
    discover: async () => {
      discoveries += 1;
      return {
        agents: [
          {
            agentId: "one",
            databasePath: "/project/one/agent.sqlite",
            sessionCount: 1,
          },
        ],
        sessions: saved,
        problems: [],
      };
    },
  };
  const overrides = dependencies(undefined, {
    createServiceManager: () => manager,
    renderPicker: () => {
      throw new Error("numbered resume must not open picker");
    },
  });
  await runFungiCli(
    ["sessions", "list", "-C", "/tmp"],
    {
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
      },
    },
    overrides,
  );
  assert.match(output, /1\. Recent work {2}recent/u);
  assert.match(output, /2\. Older work {2}older/u);
  assert.doesNotMatch(output, /[^\P{Cc}\n\t]|[\u202a-\u202e\u2066-\u2069]/u);
  await runFungiCli(["sessions", "resume", "2", "-C", "/tmp"], {}, overrides);
  await runFungiCli(
    ["sessions", "resume", "older", "-C", "/tmp"],
    {},
    overrides,
  );
  await runFungiCli(["sessions", "resume", "old", "-C", "/tmp"], {}, overrides);
  await runFungiCli(
    ["sessions", "resume", "--last", "-C", "/tmp"],
    {},
    overrides,
  );
  assert.equal(discoveries, 5);
  assert.equal(resumed, 3);
  assert.equal(latestResumed, 1);
});

test("sessions status --json exposes the owner's typed state through the Local service", async () => {
  let output = "";
  let closed = 0;
  let inspectedLimit;
  let inspectedSessionId;
  const manager = {
    discover: async () => ({
      agents: [
        {
          agentId: "one",
          databasePath: "/project/one/agent.sqlite",
          sessionCount: 1,
        },
      ],
      problems: [{ kind: "unreadable" }],
      sessions: [{ ...choice(async () => host), sessionId: "saved-session" }],
    }),
    inspect: async (selection, options) => {
      inspectedLimit = options.limit;
      inspectedSessionId = selection.sessionId;
      return {
        snapshot: {
          sessionId: "saved-session",
          activity: {
            queue: { state: "idle" },
            cancellationRequested: false,
            retry: null,
            activeTool: null,
            lastModelChoiceSequence: null,
            compaction: null,
          },
          terminals: [
            {
              commandId: "command-1",
              outcome: "completed",
              sequence: 3,
              diagnostic: null,
            },
          ],
          toolOutput: [],
          progress: null,
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  };
  await runFungiCli(
    ["sessions", "status", "--json", "-C", "/tmp"],
    {
      stdout: {
        write: (value) => {
          output += String(value);
          return true;
        },
      },
    },
    { createServiceManager: () => manager },
  );
  assert.deepEqual(JSON.parse(output), {
    schemaVersion: 2,
    sessionId: "saved-session",
    state: "waiting_for_you",
    label: "idle",
    viewState: { kind: "waiting_for_you" },
    activity: {
      queue: { state: "idle" },
      cancellationRequested: false,
      retry: null,
      activeTool: null,
      lastModelChoiceSequence: null,
      compaction: null,
    },
    lastTerminal: {
      commandId: "command-1",
      outcome: "completed",
      sequence: 3,
      diagnostic: null,
    },
    lastActivityAt: 2,
  });
  assert.equal(inspectedLimit, 1);
  assert.equal(inspectedSessionId, "saved-session");
  assert.equal(closed, 1);
  output = "";
  await runFungiCli(
    ["sessions", "status", "saved", "--json", "-C", "/tmp"],
    {
      stdout: {
        write: (value) => {
          output += String(value);
          return true;
        },
      },
    },
    { createServiceManager: () => manager },
  );
  assert.equal(JSON.parse(output).state, "waiting_for_you");
  assert.equal(closed, 2);
});

test("session ID selectors prefer an exact ID and reject ambiguous prefixes", async () => {
  let resumed = 0;
  const manager = {
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
          ...choice(async () => {
            resumed += 1;
            return host;
          }),
          sessionId: "session_abc",
        },
        { ...choice(async () => host), sessionId: "session_abcd" },
      ],
    }),
  };
  const overrides = dependencies(undefined, {
    createServiceManager: () => manager,
  });
  await runFungiCli(
    ["sessions", "resume", "session_abc", "-C", "/tmp"],
    {},
    overrides,
  );
  assert.equal(resumed, 1);
  await assert.rejects(
    runFungiCli(
      ["sessions", "resume", "session_ab", "-C", "/tmp"],
      {},
      overrides,
    ),
    /Session ID prefix session_ab matches 2 Sessions/u,
  );
});

test("rejects launch-time model selection before fresh, latest, or picked Session effects", async () => {
  const expected = {
    providerId: "openai",
    modelId: "gpt-5.6-terra",
    reasoning: "high",
  };
  let connections = 0;
  const manager = {
    connect: async () => {
      connections += 1;
      throw new Error("model selection must reject before connecting");
    },
  };
  await assert.rejects(
    runTuiCli(
      { invocationRoot: "/tmp", ...expected },
      dependencies(
        { sessions: [], problems: [] },
        { createServiceManager: () => manager },
      ),
    ),
    /Session model selection requires the shared Local preference contract/u,
  );
  assert.equal(connections, 0);

  for (const last of [true, false]) {
    let resumes = 0;
    let pickerRenders = 0;
    const saved = choice(async () => {
      resumes += 1;
      return host;
    });
    await assert.rejects(
      runTuiCli(
        { invocationRoot: "/tmp", resume: true, last, ...expected },
        dependencies(
          { sessions: [saved], problems: [] },
          {
            createServiceManager: () => manager,
            renderPicker: () => {
              pickerRenders += 1;
            },
          },
        ),
      ),
      /Session model selection requires the shared Local preference contract/u,
    );
    assert.equal(resumes, 0);
    assert.equal(pickerRenders, 0);
  }
});

test("a vanished selected store fails visibly without falling through", async () => {
  const vanished = choice(async () => {
    throw new Error("selected conversation vanished");
  });
  let shown;
  let connections = 0;
  await runTuiCli(
    { invocationRoot: "/tmp", resume: true },
    dependencies(
      { sessions: [vanished], problems: [] },
      {
        renderPicker: (_root, _sessions, onSelect) => onSelect(0),
        createServiceManager: () => ({
          connect: async () => {
            connections++;
            throw new Error("must not fall through");
          },
        }),
        renderRecovery: (_root, error, _retry, exit) => {
          shown = error.message;
          exit();
        },
      },
    ),
  );
  assert.match(shown, /selected conversation vanished/u);
  assert.equal(connections, 0);
});

test("runTuiCli does not open a Session after its renderer dies during startup", async () => {
  const opening = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let rendererOptions;
  let roots = 0;
  let renders = 0;
  let hostCloses = 0;
  let serviceStops = 0;
  let rendererDestroys = 0;
  const renderer = {
    destroy: () => {
      rendererDestroys += 1;
    },
  };
  const running = runTuiCli(
    { invocationRoot: "/tmp" },
    dependencies(
      { sessions: [], problems: [] },
      {
        loadThemePreference: async () => ({ theme: "terminal" }),
        createServiceManager: () => ({
          discover: async () => ({
            agents: [],
            sessions: [],
            problems: [],
          }),
          models: async () => [],
          connect: async () => ({
            sandboxStatus: async () => ({
              state: "available",
              requireSandbox: false,
            }),
            agentId: "agent-fixture",
            sessionId: "session-fixture",
            databasePath: "/tmp/renderer-loss.sqlite",
            session: {
              modelPreference: {
                read: async () => null,
                set: async () => undefined,
              },
            },
            close: async () => {
              hostCloses += 1;
            },
          }),
          stop: async () => {
            serviceStops += 1;
          },
        }),
        createRenderer: async (options) => {
          rendererOptions = options;
          entered.resolve();
          return opening.promise;
        },
        createRoot: () => {
          roots += 1;
          return { unmount: () => undefined };
        },
        render: (_root, _queryClient, _session, _commands, onExit) => {
          renders += 1;
          onExit();
        },
      },
    ),
  );

  await entered.promise;
  rendererOptions.onDestroy();
  opening.resolve(renderer);
  await running;

  assert.equal(roots, 0, "a destroyed renderer never mounts a frame");
  assert.equal(renders, 0, "a destroyed renderer never starts a frame");
  assert.equal(hostCloses, 0, "no Session connection was acquired");
  assert.equal(
    serviceStops,
    0,
    "client cleanup does not stop the Local service",
  );
  assert.equal(rendererDestroys, 1, "the destroyed renderer is cleaned once");
});

test("runTuiCli suppresses a picker after its renderer dies before opening settles", async () => {
  const opening = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let rendererOptions;
  let roots = 0;
  let pickerRenders = 0;
  let resumed = 0;
  let opened = 0;
  let rendererDestroys = 0;
  const renderer = {
    destroy: () => {
      rendererDestroys += 1;
    },
  };
  const saved = choice(async () => {
    resumed += 1;
    throw new Error("destroyed picker must not resume");
  });
  const running = runTuiCli(
    { invocationRoot: "/tmp", resume: true },
    dependencies(
      { sessions: [saved], problems: [] },
      {
        loadThemePreference: async () => ({ theme: "terminal" }),
        openHost: async () => {
          opened += 1;
          throw new Error("destroyed picker must not open a host");
        },
        createRenderer: async (options) => {
          rendererOptions = options;
          entered.resolve();
          return opening.promise;
        },
        createRoot: () => {
          roots += 1;
          return { unmount: () => undefined };
        },
        renderPicker: (_root, _sessions, _onSelect, onCancel) => {
          pickerRenders += 1;
          onCancel();
        },
      },
    ),
  );

  await entered.promise;
  rendererOptions.onDestroy();
  opening.resolve(renderer);
  await running;

  assert.equal(roots, 0, "a destroyed renderer never mounts the picker");
  assert.equal(
    pickerRenders,
    0,
    "a destroyed renderer never starts the picker",
  );
  assert.equal(resumed, 0);
  assert.equal(opened, 0);
  assert.equal(
    rendererDestroys,
    1,
    "the destroyed picker renderer is cleaned once",
  );
});

test("renderer exit interrupts a pending service selection without stopping the service", async () => {
  const selectionStarted = Promise.withResolvers();
  let rendererOptions;
  let rootUnmounts = 0;
  let serviceStops = 0;
  const running = runTuiCli(
    { invocationRoot: "/tmp" },
    dependencies(
      { agents: [], sessions: [], problems: [] },
      {
        createServiceManager: () => ({
          connect: async (_selection, options) => {
            selectionStarted.resolve();
            await new Promise((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(options.signal.reason),
                { once: true },
              );
            });
            throw new Error("aborted selection unexpectedly continued");
          },
          stop: async () => {
            serviceStops += 1;
          },
        }),
        createRenderer: async (options) => {
          rendererOptions = options;
          return { destroy: () => undefined };
        },
        createRoot: () => ({
          unmount: () => {
            rootUnmounts += 1;
          },
        }),
      },
    ),
  );

  await selectionStarted.promise;
  rendererOptions.onDestroy();
  await running;

  assert.equal(rootUnmounts, 1);
  assert.equal(serviceStops, 0);
});

function renderedNodes(node) {
  return [node, ...node.getChildren().flatMap(renderedNodes)];
}

/** Poll a condition the fixture sets from outside the render loop. */
async function waitFor(ready) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (ready()) return;
    await act(async () => delay(10));
  }
  throw new Error("The expected condition never held");
}

async function withCli(
  check,
  {
    cancel,
    prompt,
    watch,
    goal,
    preferences = {},
    prepareRenderer,
    enableKeymap = false,
    cliOptions = {},
    rendererOptions = {},
    expectedWatchCalls = 1,
    expectedCloseCalls = 1,
    queryClient,
    auth = async () => configuredModelAccess(preferences.listModels?.() ?? []),
    beforeFrame,
    readyText = "Ask anything",
  } = {},
) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const fixture = createTuiFixture({
    goal:
      goal === undefined
        ? undefined
        : { startedAt: fixtureGoalStartedAt, pauseCause: null, ...goal },
  });
  const setup = await createTestRenderer({
    width: 72,
    height: 20,
    ...rendererOptions,
  });
  prepareRenderer?.(setup.renderer);
  const commands = createWhistle();
  const frameQueryClient = queryClient ?? createQueryClient();
  const requests = [];
  let hostCloses = 0;
  let running;
  // Allocation only makes the Connecting frame possible. Keep startup inside
  // act until the CLI requests the admitted conversation frame.
  const conversationReady = Promise.withResolvers();
  try {
    await act(async () => {
      running = runTuiCli(
        { invocationRoot: "/tmp", ...cliOptions },
        {
          prepareClientExtensions: noOpClientExtensions,
          loadThemePreference: async () => ({ theme: "terminal" }),
          saveThemePreference: async () => {
            throw new Error("Unexpected theme save in fixture");
          },
          ...preferences,
          createQueryClient: () => frameQueryClient,
          createServiceManager: () => ({
            discover: async () => ({
              agents: [],
              sessions: [],
              problems: [],
            }),
            models: async () => preferences.listModels?.() ?? [],
            auth,
            connect: async () => {
              await beforeFrame?.(setup);
              return {
                sandboxStatus: async () => ({
                  state: "available",
                  requireSandbox: false,
                }),
                ...fixture.identity,
                databasePath: "/tmp/fixture-session.sqlite",
                session: {
                  ...fixture.session,
                  watch: () =>
                    watch === undefined
                      ? fixture.session.watch()
                      : watch(fixture.session.watch),
                  modelPreference: {
                    read: async () => null,
                    set: async () => undefined,
                  },
                  command: (input) => {
                    requests.push(input);
                    if (input.type === "cancel" && cancel) return cancel(input);
                    if (input.type === "prompt" && prompt)
                      return prompt(input, fixture.session.command);
                    return fixture.session.command(input);
                  },
                },
                rebind: async () => ({ kind: "rebound" }),
                close: async () => {
                  hostCloses += 1;
                },
              };
            },
          }),
          createWhistle: () => commands,
          enableKeymap,
          render: (
            root,
            frameQueryClient,
            session,
            frameCommands,
            onExit,
            theme,
            controls,
          ) => {
            renderTuiConversation(root, frameQueryClient, {
              ...theme,
              commands: frameCommands,
              onExit,
              session,
              ...controls,
            });
            conversationReady.resolve();
          },
          createRenderer: async () => setup.renderer,
        },
      );
      await Promise.race([
        conversationReady.promise,
        running.then(() => {
          throw new Error("CLI exited before rendering a conversation");
        }),
      ]);
    });
    await setup.waitForFrame((frame) => frame.includes(readyText));
    const input = renderedNodes(setup.renderer.root).find(
      (node) => node instanceof TextareaRenderable,
    );
    assert.ok(input);
    const type = async (text) => {
      await act(async () => setup.mockInput.pressKey("u", { ctrl: true }));
      await act(async () => setup.mockInput.typeText(text));
      await act(async () => setup.renderOnce());
    };
    const submit = async () => {
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
    };
    await check({
      setup,
      commands,
      fixture,
      input,
      requests,
      type,
      submit,
      pushFrame: async (frame) => {
        const delivered = Promise.withResolvers();
        const observer = new QueryObserver(frameQueryClient, {
          ...sessionQueryOptions(fixture.session),
          enabled: false,
        });
        const unsubscribe = observer.subscribe(
          notifyManager.batchCalls((result) => {
            if (result.data?.snapshot?.cursor === frame.cursor)
              delivered.resolve();
          }),
        );
        try {
          await act(async () => {
            fixture.pushFrame(frame);
            await delivered.promise;
          });
        } finally {
          unsubscribe();
        }
      },
      get hostCloses() {
        return hostCloses;
      },
    });
    assert.equal(fixture.watchCalls(), expectedWatchCalls);
  } finally {
    if (hostCloses === 0)
      await act(async () => commands.execute("tui:exit", { origin: "slash" }));
    await act(async () => running);
    const ownerDestroyed = setup.renderer.isDestroyed;
    if (!ownerDestroyed) setup.renderer.destroy();
    assert.equal(ownerDestroyed, true, "application owns renderer cleanup");
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
  await fixture.waitForClose();
  assert.equal(fixture.closeCalls(), expectedCloseCalls);
  assert.equal(hostCloses, 1);
  assert.equal(setup.renderer.listenerCount("resize"), 0);
  assert.deepEqual(
    await commands.execute("retired-command", { origin: "slash" }),
    {
      status: "closed",
    },
  );
}

test("text sent while a new TUI session connects reaches the composer", async () => {
  await withCli(
    async ({ input }) => {
      assert.equal(input.plainText, "startup instruction and paste");
    },
    {
      beforeFrame: async (setup) => {
        await setup.mockInput.typeText("startup instruction");
        setup.mockInput.pasteBracketedText(" and paste");
      },
      readyText: "startup instruction",
    },
  );
});

test("text sent immediately after closing the model picker reaches the composer", async () => {
  await withCli(
    async ({ setup, input, type, submit }) => {
      await type("/model");
      await submit();
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Use agent model")),
      );
      assert.ok(
        renderedNodes(setup.renderer.root).some(
          (node) => node.focused && node.id.startsWith("box-"),
        ),
      );
      await act(async () => {
        setup.renderer._internalKeyInput.emit(
          "keypress",
          new KeyEvent({
            name: "escape",
            raw: "\u001b",
            sequence: "\u001b",
            eventType: "press",
            source: "raw",
            number: false,
            ctrl: false,
            meta: false,
            shift: false,
            option: false,
          }),
        );
        await setup.mockInput.typeText("next instruction");
      });
      await act(async () => setup.renderOnce());
      assert.ok(input.plainText.endsWith("next instruction"), input.plainText);
    },
    { enableKeymap: true, rendererOptions: { useKittyKeyboard: null } },
  );
});

test("a pending theme save keeps its dialog and command definitions until completion", async () => {
  const saving = Promise.withResolvers();
  const started = Promise.withResolvers();
  await withCli(
    async ({ setup, commands, type, submit, input }) => {
      // Initial Session catalogs arrive after the first composer frame.
      // Compare graph identity only after those maintained commands are admitted.
      await act(async () =>
        waitForCommandGraph(commands, (snapshot) =>
          ["goal", "loop"].every((alias) =>
            snapshot.slash.some((row) => row.alias === alias),
          ),
        ),
      );
      const graph = commands.snapshot();
      await type("/theme");
      await submit();
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await started.promise;
      await act(async () => executeEscape(commands));
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /Saving theme/u);
      assert.equal(input.focused, false);
      assert.equal(commands.snapshot(), graph);
      await act(async () => {
        saving.resolve();
        await saving.promise;
      });
      await act(async () => setup.renderOnce());
      assert.doesNotMatch(setup.captureCharFrame(), /Saving theme/u);
      assert.equal(input.focused, true);
    },
    {
      preferences: {
        saveThemePreference: () => {
          started.resolve();
          return saving.promise;
        },
      },
    },
  );
});

test.each([
  ["OpenAI API key", "api_key"],
  ["Sign in with ChatGPT", "oauth"],
])(
  "frame dialog dismissal waits for %s auth cancellation and reports its result",
  async (methodLabel, authType) => {
    const started = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    await withCli(
      async ({ setup, commands, type, submit, input, hostCloses }) => {
        await type("/login");
        await submit();
        await act(async () =>
          setup.waitForFrame((frame) =>
            frame.includes("Choose a model provider"),
          ),
        );
        await act(async () => setup.mockInput.typeText("OpenAI"));
        await act(async () => setup.mockInput.pressEnter());
        await act(async () =>
          setup.waitForFrame((frame) =>
            frame.includes("How do you want to sign in to OpenAI?"),
          ),
        );
        assert.match(setup.captureCharFrame(), /OpenAI API key/u);
        assert.match(setup.captureCharFrame(), /Sign in with ChatGPT/u);
        if (authType === "oauth")
          await act(async () => setup.mockInput.pressArrow("down"));
        await act(async () => setup.mockInput.pressEnter());
        await started.promise;
        await act(async () => {
          await executeEscape(commands);
        });
        await cancelled.promise;
        await act(async () =>
          setup.waitForFrame(
            (frame) => !frame.includes("Sign in to a model provider"),
          ),
        );
        assert.equal(input.focused, true);
        assert.equal(hostCloses, 0);
      },
      {
        auth: async (request, interaction) => {
          if (request.command === "status") return configuredModelAccess([]);
          assert.deepEqual(request, {
            command: "login",
            provider: "openai",
            authType,
          });
          started.resolve();
          await new Promise((resolve) =>
            interaction.signal.addEventListener("abort", resolve, {
              once: true,
            }),
          );
          cancelled.resolve();
          return { kind: "completed" };
        },
      },
    );
  },
);

test("theme preview and dialog replacement preserve the Whistle command graph", async () => {
  await withCli(async ({ setup, commands, type, submit }) => {
    // The Session advertises these commands asynchronously after its first frame.
    // Take the baseline after attachment, so this tests preview rather than loading.
    await act(async () =>
      waitForCommandGraph(commands, (snapshot) => {
        const rows = snapshot.palette;
        return (
          rows.some((row) => row.title === "Goal") &&
          rows.some((row) => row.title === "Loop")
        );
      }),
    );
    const before = commands.snapshot();
    await type("/theme");
    await submit();
    await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => setup.renderOnce());
    assert.equal(
      commands.snapshot(),
      before,
      "preview must not dispose and register command definitions",
    );
    await act(async () => {
      void executeAlias(commands, "help", { origin: "palette" });
    });
    await act(async () => setup.renderOnce());
    assert.match(setup.captureCharFrame(), /Commands/u);
    assert.equal(
      commands.snapshot(),
      before,
      "replacement must not rebuild the command graph",
    );
  });
});

test("the production CLI opens /theme and Escape restores input focus", async () => {
  await withCli(async ({ setup, fixture, input, type, submit }) => {
    await type("/theme");
    assert.match(setup.captureCharFrame(), /\/theme\s+Choose terminal colors/u);
    await submit();
    await act(async () => setup.renderOnce());
    assert.match(setup.captureCharFrame(), /▶ ● \w+/u);
    assert.ok(setup.renderer.currentFocusedRenderable?.focused);
    assert.equal(input.focused, false);
    assert.equal(input.plainText, "");
    await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => setup.renderOnce());
    assert.match(setup.captureCharFrame(), /Mocha/u);
    await act(async () => {
      const keypress = once(setup.renderer.keyInput, "keypress");
      setup.mockInput.pressEscape();
      await keypress;
    });
    await act(async () => setup.renderOnce());
    assert.equal(input.focused, true);
    await type("focus survived");
    assert.equal(input.plainText, "focus survived");
    assert.equal(fixture.promptCalls(), 0);
  });
});

test("the production CLI keeps the frame mounted under the /model choice", async () => {
  await withCli(
    async ({ setup, type, submit, input, fixture }) => {
      await type("/model");
      await submit();
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Use agent model")),
      );
      assert.ok(setup.renderer.currentFocusedRenderable?.focused);
      assert.match(setup.captureCharFrame(), /Model/u);
      assert.equal(input.focused, false);
      await pressEscape(setup);
      assert.equal(input.focused, true);
      // A dispatched command is consumed even when its picker is dismissed.
      assert.doesNotMatch(setup.captureCharFrame(), /cancelled/u);
      assert.equal(input.plainText, "");
      assert.equal(fixture.promptCalls(), 0);
      await type("/model");
      await submit();
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Use agent model")),
      );
      assert.ok(
        renderedNodes(setup.renderer.root).some(
          (node) => node.focused && node.id.startsWith("box-"),
        ),
      );
      await pressDecodedKey(setup, () =>
        setup.mockInput.pressKey("c", { ctrl: true }),
      );
      assert.equal(input.focused, true);
      assert.equal(setup.renderer.isDestroyed, false);
      assert.equal(fixture.promptCalls(), 0);
    },
    { enableKeymap: true, rendererOptions: { useKittyKeyboard: null } },
  );
});

test("account slash commands dispatch through the injected auth owner", async () => {
  const actions = [];
  await withCli(
    async ({ type, submit, fixture }) => {
      await type("/account");
      await submit();
      assert.deepEqual(actions, ["status"]);
      assert.equal(fixture.promptCalls(), 0);
    },
    {
      auth: async ({ command }, interaction) => {
        actions.push(command);
        interaction.notify({ type: "info", message: "configured" });
        return configuredModelAccess([]);
      },
    },
  );
});

test("account failure stays failed through command execution and the native composer", async () => {
  await withCli(
    async ({ commands, type, submit, input, setup, fixture }) => {
      await act(async () => {
        const outcome = await commands.execute("account:account", {
          origin: "agent",
        });
        assert.equal(outcome.status, "failed");
        assert.equal(outcome.error.message, "Account service unavailable");
      });
      await type("/account");
      await submit();
      assert.match(setup.captureCharFrame(), /Account service unavailable/u);
      assert.equal(input.plainText, "/account");
      assert.equal(input.focused, true);
      assert.equal(fixture.promptCalls(), 0);
    },
    {
      auth: async () => {
        throw new Error("Account service unavailable");
      },
    },
  );
});

test("Terminal reselection refreshes the native palette and missing replies keep input usable", async () => {
  const calls = [];
  let detection;
  await withCli(
    async ({ setup, type, submit, input }) => {
      await type("input before missing reply");
      assert.equal(input.plainText, "input before missing reply");
      await act(async () => {
        await detection;
      });
      await act(async () => setup.renderOnce());
      assert.deepEqual(calls, ["clear", "get"]);
      assert.doesNotMatch(
        setup.captureCharFrame(),
        /Terminal palette unavailable/u,
      );
      assert.equal(input.plainText, "input before missing reply");
      await type("/theme");
      await submit();
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.renderOnce());
      assert.doesNotMatch(
        setup.captureCharFrame(),
        /Terminal palette unavailable/u,
      );
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      await type("/theme");
      await submit();
      await act(async () => setup.mockInput.pressArrow("up"));
      await act(async () => setup.renderOnce());
      assert.deepEqual(calls, ["clear", "get", "clear", "get"]);
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      assert.deepEqual(calls.slice(-2), ["clear", "get"]);
      assert.equal(calls.length, 6);
      await type("/theme");
      await submit();
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      assert.equal(
        calls.length,
        8,
        "confirming Terminal again refreshes detection",
      );
      assert.deepEqual(calls.slice(-2), ["clear", "get"]);
      assert.equal(setup.renderer.listenerCount("palette"), 1);
      assert.equal(setup.renderer.listenerCount("theme_mode"), 1);
      assert.equal(input.focused, true);
    },
    {
      preferences: { saveThemePreference: async () => undefined },
      prepareRenderer: (renderer) => {
        renderer.stdin.isTTY = true; // Real OSC query times out without a reply.
        const clear = renderer.clearPaletteCache.bind(renderer);
        const get = renderer.getPalette.bind(renderer);
        renderer.clearPaletteCache = () => {
          calls.push("clear");
          clear();
        };
        renderer.getPalette = (options) => {
          calls.push("get");
          detection = get(options);
          return detection;
        };
      },
    },
  );
});

test("theme preview stays temporary and confirmed Latte survives a new CLI launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-cli-theme-"));
  const path = join(directory, "tui.json");
  const saved = Promise.withResolvers();
  const preferences = {
    loadThemePreference: () => loadThemePreference(path),
    saveThemePreference: async (theme) => {
      await saveThemePreference(theme, path);
      saved.resolve();
    },
  };
  try {
    await withCli(
      async ({ setup, type, submit, input, fixture }) => {
        await type("/theme");
        await submit();
        await act(async () => setup.mockInput.pressArrow("down"));
        await act(async () => setup.mockInput.pressArrow("down"));
        await act(async () => setup.renderOnce());
        await assert.rejects(readFile(path), { code: "ENOENT" });
        await act(async () => {
          setup.mockInput.pressEnter();
          await saved.promise;
        });
        await act(async () => setup.renderOnce());
        assert.equal(input.focused, true);
        assert.equal(fixture.promptCalls(), 0);
        assert.deepEqual(await loadThemePreference(path), { theme: "latte" });
      },
      { preferences },
    );
    await withCli(
      async ({ setup, type, submit }) => {
        await type("/theme");
        await submit();
        await act(async () => setup.renderOnce());
        assert.match(setup.captureCharFrame(), /▶ ● Latte/u);
      },
      { preferences },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI fixture waits for asynchronous Local admission before inspecting frames", async () => {
  await withCli(
    async ({ setup }) => {
      assert.match(setup.captureCharFrame(), /Ask anything/u);
    },
    {
      // Producer latency, not a longer frame wait: Local admission can settle
      // after the renderer has exhausted its bounded renderless passes.
      beforeFrame: () => delay(100),
    },
  );
});

test("invalid theme preferences and failed saves stay visible without replacing bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-cli-theme-invalid-"));
  const path = join(directory, "tui.json");
  const bytes = '{"theme":"unrecognized"}';
  const attempted = Promise.withResolvers();
  try {
    await writeFile(path, bytes);
    await withCli(
      async ({ setup, type, submit, input }) => {
        assert.match(setup.captureCharFrame(), /Unable to read/u);
        await type("/theme");
        await submit();
        await act(async () => setup.mockInput.pressArrow("down"));
        await act(async () => {
          setup.mockInput.pressEnter();
          await attempted.promise;
        });
        await act(async () => setup.renderOnce());
        assert.match(setup.captureCharFrame(), /Unable to read/u);
        assert.match(setup.captureCharFrame(), /Esc cancel/u);
        assert.equal(await readFile(path, "utf8"), bytes);
        await act(async () => {
          const keypress = once(setup.renderer.keyInput, "keypress");
          setup.mockInput.pressEscape();
          await keypress;
        });
        await act(async () => setup.renderOnce());
        assert.equal(input.focused, true);
      },
      {
        preferences: {
          loadThemePreference: () => loadThemePreference(path),
          saveThemePreference: async (theme) => {
            try {
              await saveThemePreference(theme, path);
            } finally {
              attempted.resolve();
            }
          },
        },
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the production CLI handles /help without submitting a model prompt", async () => {
  const releaseWatch = Promise.withResolvers();
  await withCli(
    async ({ setup, commands, fixture, input, type }) => {
      assert.equal(
        commands
          .snapshot()
          .slash.some(({ alias }) => alias === "goal" || alias === "loop"),
        false,
      );
      await act(async () => {
        releaseWatch.resolve();
        await waitForCommandGraph(commands, (snapshot) => {
          const aliases = snapshot.slash.map(({ alias }) => alias);
          return aliases.includes("goal") && aliases.includes("loop");
        });
      });
      const advertised = commands.snapshot().slash.map((row) => row.alias);
      assert.equal(new Set(advertised).size, advertised.length);
      assert.deepEqual(
        new Set(advertised),
        new Set([
          "help",
          "keys",
          "clear",
          "session",
          "cancel",
          "stop",
          "reconnect",
          "retry",
          "continue",
          "queue",
          "details",
          "exit",
          "resume",
          "theme",
          "model",
          "thinking",
          "new",
          "fork",
          "account",
          "login",
          "logout",
          "goal",
          "loop",
          "plan",
          "compact",
          "name",
          "reload",
          "archive",
          "extensions",
        ]),
      );
      await type("/");
      await type("/he");
      assert.match(setup.captureCharFrame(), /\/help\s+Show commands/u);
      assert.doesNotMatch(setup.captureCharFrame(), /\/cancel/u);
      await type("ordinary draft");
      await act(async () => {
        void executeAlias(commands, "help", { origin: "slash" });
      });
      await act(async () => setup.renderOnce());
      assert.equal(fixture.promptCalls(), 0);
      assert.match(setup.captureCharFrame(), /Commands/u);
      assert.ok(
        renderedNodes(setup.renderer.root).some(
          (node) => node instanceof InputRenderable && node.focused,
        ),
      );
      assert.equal(input.plainText, "ordinary draft");
      await pressEscape(setup);
      assert.equal(input.plainText, "ordinary draft");
      assert.equal(input.focused, true);
    },
    {
      watch: async (open) => {
        await releaseWatch.promise;
        return open();
      },
    },
  );
});

test("accepted prompt clears the native composer", async () => {
  await withCli(
    async ({ input, requests, type, submit, setup }) => {
      await type("Clear this sent prompt");
      await submit();
      await act(async () => setup.waitForFrame(() => input.plainText === ""));
      assert.equal(
        requests.filter((request) => request.type === "prompt").length,
        1,
      );
      assert.equal(input.plainText, "");
    },
    { enableKeymap: true, rendererOptions: { useKittyKeyboard: null } },
  );
});

test("pending prompt acceptance preserves replacement input", async () => {
  const accepted = Promise.withResolvers();
  const settled = Promise.withResolvers();
  await withCli(
    async ({ input, type, submit, setup }) => {
      await type("First prompt");
      await submit();
      assert.equal(input.plainText, "");
      await type("Next prompt");
      await act(async () => {
        accepted.resolve();
        await settled.promise;
      });
      await act(async () => setup.renderOnce());
      assert.equal(input.plainText, "Next prompt");
    },
    {
      prompt: async (input, command) => {
        await accepted.promise;
        const result = await command(input);
        settled.resolve();
        return result;
      },
      enableKeymap: true,
      rendererOptions: { useKittyKeyboard: null },
    },
  );
});

test("rejected prompt keeps the native composer input", async () => {
  await withCli(
    async ({ input, type, submit, setup }) => {
      await type("Keep this failed prompt");
      await submit();
      await act(async () =>
        setup.waitForFrame((frame) =>
          frame.includes("/retry · or edit and submit the draft"),
        ),
      );
      assert.equal(input.plainText, "Keep this failed prompt");
      assert.match(setup.captureCharFrame(), /stopped/u);
      assert.match(
        setup.captureCharFrame(),
        /\/retry · or edit and submit the draft/u,
      );
    },
    {
      prompt: async () => {
        throw new Error("Submission rejected");
      },
      enableKeymap: true,
      rendererOptions: { useKittyKeyboard: null },
    },
  );
});

function failedRunFrame() {
  return {
    kind: "update",
    delivery: "live",
    cursor: "failed-run",
    pending: { total: 0, prompts: [], hasMore: false },
    messages: [
      {
        id: "failed-user",
        commandId: "failed-command",
        sequence: 1,
        value: { role: "user", content: "Original task", timestamp: 1 },
      },
    ],
    terminals: [
      {
        commandId: "failed-command",
        outcome: "failed",
        sequence: 2,
        diagnostic: "Tool execution failed",
      },
    ],
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
  };
}

test("a failed run shows choices and a new draft enters as a fresh instruction", async () => {
  await withCli(async ({ setup, requests, type, submit, pushFrame }) => {
    await pushFrame(failedRunFrame());
    await setup.waitForFrame((frame) =>
      frame.includes("Stopped: Tool execution failed"),
    );
    assert.match(setup.captureCharFrame(), /Stopped: Tool execution failed/u);
    assert.match(
      setup.captureCharFrame(),
      /\/retry · \/continue · or type a new instruction/u,
    );
    await type("?");
    await submit();
    assert.match(setup.captureCharFrame(), /\?/u);
    const prompt = requests
      .filter((request) => request.type === "prompt")
      .at(-1);
    assert.equal(prompt?.text, "?");
    assert.equal(prompt?.delivery, "steer");
    assert.notEqual(prompt?.requestId, "failed-command");
  });
});

test("the native recovery commands keep retry and continue distinct", async () => {
  for (const command of ["/retry", "/continue"]) {
    await withCli(async ({ setup, requests, type, submit, pushFrame }) => {
      await pushFrame(failedRunFrame());
      await setup.waitForFrame((frame) =>
        frame.includes("Stopped: Tool execution failed"),
      );
      await type(command);
      await submit();
      await act(async () => setup.renderOnce());
      const prompt = requests
        .filter((request) => request.type === "prompt")
        .at(-1);
      assert.ok(prompt);
      assert.equal(prompt.delivery, "followUp");
      assert.notEqual(prompt.requestId, "failed-command");
      assert.equal(
        prompt.text,
        command === "/retry"
          ? "Original task"
          : "Continue the previous task. First address the error that stopped it.",
      );
    });
  }
});

test("exact aliases are commands and unsupported slash drafts stay out of prompts", async () => {
  await withCli(
    async ({ commands, fixture, requests, setup, type, submit }) => {
      for (const [text, error] of [
        ["/unknown", /Unsupported command: \/unknown/u],
        ["/help now", /\/help takes no arguments/u],
        ["/queue sideways", /Use \/queue list\./u],
      ]) {
        await type(text);
        await submit();
        await act(async () => setup.waitForFrame((frame) => error.test(frame)));
        assert.match(setup.captureCharFrame(), error);
      }
      for (const text of [" /help", "ordinary prompt"]) {
        await type(text);
        await submit();
      }
      assert.equal(fixture.promptCalls(), 2);
      assert.deepEqual(
        requests.map((input) => input.text),
        [" /help", "ordinary prompt"],
      );
      const aliases = commands.snapshot().slash.map((row) => row.alias);
      assert.equal(new Set(aliases).size, aliases.length);
      assert.ok(aliases.includes("archive"));
      assert.ok(aliases.includes("extensions"));
      assert.ok(aliases.includes("stop"));
    },
  );
});

test("/compact queues owner compaction work without a model prompt", async () => {
  await withCli(async ({ fixture, requests, setup, type, submit }) => {
    await type("/compact");
    await submit();
    await waitFor(() => requests.some((input) => input.type === "compact"));
    await act(async () => setup.renderOnce());
    assert.doesNotMatch(setup.captureCharFrame(), /Compaction queued/u);
    const compacts = requests.filter((input) => input.type === "compact");
    assert.equal(compacts.length, 1);
    assert.match(compacts[0]?.requestId ?? "", /^\S+$/u);
    assert.equal(fixture.promptCalls(), 0);
  });
});

test("/name sets and clears the Session title through the owner", async () => {
  await withCli(async ({ fixture, requests, setup, type, submit }) => {
    await type("/name Fern notes");
    await submit();
    await waitFor(() => requests.length >= 1);
    await type("/name");
    await submit();
    await waitFor(
      () => requests.filter((input) => input.type === "title").length === 2,
    );
    await act(async () => setup.renderOnce());
    assert.doesNotMatch(
      setup.captureCharFrame(),
      /named "Fern notes"|title cleared/u,
    );
    assert.deepEqual(
      requests.filter((input) => input.type === "title"),
      [
        { type: "title", title: "Fern notes" },
        { type: "title", title: null },
      ],
    );
    assert.equal(fixture.promptCalls(), 0);
  });
});

test("/reload refreshes supported owners and reports the rest without a prompt", async () => {
  await withCli(async ({ fixture, setup, type, submit }) => {
    await type("/reload");
    await submit();
    await act(async () =>
      setup.waitForFrame((frame) => /Not reloadable:/u.test(frame)),
    );
    const frame = setup.captureCharFrame().replace(/\s+/gu, " ");
    assert.match(frame, /Refreshed now: model catalog, terminal colors\./u);
    // The report is a toast: its long lines wrap inside the card.
    assert.match(frame, /Re-read at the next turn: AGENTS\.md instructions/u);
    assert.match(frame, /skills\./u);
    assert.match(frame, /client extensions/u);
    assert.match(frame, /Session extensions/u);
    assert.match(frame, /keybindings/u);
    assert.equal(fixture.promptCalls(), 0);
  });
});

function executeEscape(commands) {
  const row = commands
    .snapshot()
    .bindings.find(({ binding }) => binding === "escape");
  assert.ok(row, "The selected conversation owns an Escape binding");
  return commands.execute(row.commandId, { origin: "keyboard" });
}

async function startFixtureRun(fixture, setup, requestId) {
  await act(async () => {
    await fixture.session.command({
      type: "prompt",
      text: "Active work",
      requestId,
    });
    fixture.confirmLatestPrompt();
    await setup.renderOnce();
  });
  // Owner admission precedes asynchronous watch delivery and Query notification.
  // Cancel is available only after the CLI has observed the active run.
  // Native frame waits finish when the renderer is idle, before external watch
  // deliveries and Query's notification timers. Observe the rendered outcome.
  await waitForFrame(setup, (frame) =>
    frame.includes("Fixture is streaming a reply."),
  );
}

for (const scenario of ["changed-away-and-back", "unchanged", "later-typing"]) {
  test(`async cancel clears only its handled draft: ${scenario}`, async () => {
    const pending = Promise.withResolvers();
    await withCli(
      async ({ fixture, input, requests, type, submit, setup }) => {
        await startFixtureRun(fixture, setup, scenario);
        await type("/cancel");
        await submit();
        assert.equal(input.plainText, "/cancel");
        if (scenario === "changed-away-and-back") {
          await type("replacement draft");
          await type("/cancel");
        } else if (scenario === "later-typing") {
          await type("later typing");
        }
        await act(async () => pending.resolve());
        await act(async () => setup.renderOnce());
        assert.equal(
          input.plainText,
          scenario === "unchanged"
            ? ""
            : scenario === "later-typing"
              ? "later typing"
              : "/cancel",
        );
        assert.equal(input.focused, true);
        assert.deepEqual(requests, [
          { type: "cancel", commandId: `owner-${scenario}` },
        ]);
        assert.equal(fixture.promptCalls(), 1);
      },
      {
        cancel: (input) =>
          pending.promise.then(() => ({
            status: "accepted",
            commandId: input.commandId,
          })),
        watch: async (watchSession) => {
          const watched = await watchSession();
          return {
            ...watched,
            changes: (async function* () {
              for await (const frame of watched.changes) {
                await delay(40);
                yield frame;
              }
            })(),
          };
        },
      },
    );
  });
}

for (const laterTyping of [false, true]) {
  test(`cancel failure is visible and preserves ${laterTyping ? "later typing" : "its draft"}`, async () => {
    const pending = Promise.withResolvers();
    await withCli(
      async ({ fixture, input, setup, type, submit }) => {
        await startFixtureRun(fixture, setup, "cancel-failure");
        await type("/cancel");
        await submit();
        if (laterTyping) await type("new draft");
        await act(async () => pending.reject(new Error("Cancel unavailable")));
        await act(async () => setup.renderOnce());
        assert.match(setup.captureCharFrame(), /\/cancel: Cancel unavailable/u);
        assert.equal(input.plainText, laterTyping ? "new draft" : "/cancel");
        assert.equal(input.focused, true);
        assert.equal(fixture.promptCalls(), 1);
      },
      {
        cancel: (input) =>
          pending.promise.then(() => ({
            status: "accepted",
            commandId: input.commandId,
          })),
      },
    );
  });
}

test("repeated cancel shares the existing pending cancellation", async () => {
  const pending = Promise.withResolvers();
  await withCli(
    async ({ fixture, input, requests, type, submit, setup }) => {
      await startFixtureRun(fixture, setup, "cancel-repeated");
      await type("/cancel");
      await submit();
      await submit();
      assert.deepEqual(requests, [
        { type: "cancel", commandId: "owner-cancel-repeated" },
      ]);
      await act(async () => pending.resolve());
      await act(async () => setup.renderOnce());
      assert.equal(input.plainText, "");
    },
    {
      cancel: (input) =>
        pending.promise.then(() => ({
          status: "accepted",
          commandId: input.commandId,
        })),
    },
  );
});

for (const deferredNotifications of [false, true]) {
  test(`native keymap Escape cancels once and keeps the composer alive${deferredNotifications ? " with deferred Query notifications" : ""}`, async () => {
    const pending = Promise.withResolvers();
    const queryClient = createQueryClient();
    await withCli(
      async ({ fixture, setup, input, requests, type }) => {
        const streaming = Promise.withResolvers();
        const observer = new QueryObserver(queryClient, {
          ...sessionQueryOptions(fixture.session),
          enabled: false,
        });
        // Like React's subscription, observe delivery through Query's notify
        // queue, not merely owner admission or a synchronous cache write.
        const unsubscribe = observer.subscribe(
          notifyManager.batchCalls((result) => {
            if (
              result.data?.snapshot?.progress?.text ===
              "Fixture is streaming a reply."
            )
              streaming.resolve();
          }),
        );
        // Same external-event bound as startFixtureRun; no render-pass polling.
        const timeout = setTimeout(
          () =>
            streaming.reject(new Error("Fixture streaming was not observed")),
          2000,
        );
        const notifications = [];
        if (deferredNotifications)
          notifyManager.setScheduler((callback) =>
            notifications.push(callback),
          );
        try {
          await act(async () => {
            await fixture.session.command({
              type: "prompt",
              text: "active work",
              requestId: "active-work",
            });
            fixture.confirmLatestPrompt();
            await setup.renderOnce();
          });
          if (deferredNotifications) {
            // The cache has advanced, but its external React notifications have
            // not. Deliver them only after the native renderer is genuinely idle.
            await act(async () => setup.waitForVisualIdle());
            assert.ok(notifications.length > 0);
            setImmediate(() => {
              notifyManager.setScheduler(defaultScheduler);
              for (const notify of notifications) notify();
            });
          }
          await act(async () => {
            await streaming.promise;
            await setup.renderOnce();
          });
          assert.match(
            setup.captureCharFrame(),
            /Fixture is streaming a reply\./u,
          );
        } finally {
          clearTimeout(timeout);
          unsubscribe();
          notifyManager.setScheduler(defaultScheduler);
        }
        await type("draft before native cancel");
        await pressEscape(setup);
        await pressEscape(setup);
        assert.deepEqual(requests, [
          { type: "cancel", commandId: "owner-active-work" },
        ]);
        assert.equal(input.focused, true);
        assert.equal(input.plainText, "draft before native cancel");
        await act(async () => pending.resolve());
      },
      {
        cancel: (input) =>
          pending.promise.then(() => ({
            status: "accepted",
            commandId: input.commandId,
          })),
        enableKeymap: true,
        rendererOptions: { useKittyKeyboard: null },
        queryClient,
      },
    );
  });
}

test("slash details and Ctrl+O share disclosure; slash exit closes the CLI", async () => {
  await withCli(
    async ({ fixture, setup, input, requests, type, submit }) => {
      await act(async () => {
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
            messageId: "thinking-message",
            revision: 1,
            text: "Working response",
            thinking: "Inspecting the command path",
            textTruncated: false,
            thinkingTruncated: false,
          },
        });
      });
      await act(async () => setup.renderOnce());
      assert.doesNotMatch(
        setup.captureCharFrame(),
        /Inspecting the command path/u,
      );
      await type("/details");
      await submit();
      assert.match(setup.captureCharFrame(), /Inspecting the command path/u);
      assert.equal(input.plainText, "");
      assert.equal(input.focused, true);
      await act(async () => setup.mockInput.pressKey("o", { ctrl: true }));
      await act(async () => setup.renderOnce());
      assert.doesNotMatch(
        setup.captureCharFrame(),
        /Inspecting the command path/u,
      );
      await type("/exit");
      await act(async () => setup.mockInput.pressEnter());
      assert.equal(setup.renderer.listenerCount("resize"), 0);
      assert.deepEqual(requests, []);
      assert.equal(fixture.promptCalls(), 0);
    },
    { enableKeymap: true },
  );
});

test("model selection offers supported thinking before changing the mounted owner", async () => {
  await withCli(
    async (context) => {
      const { setup, type, submit } = context;
      await type("/model");
      await submit();
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Use agent model")),
      );
      assert.match(setup.captureCharFrame(), /DEFAULT/u);
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await act(async () => setup.renderOnce());
      assert.match(setup.captureCharFrame(), /Thinking level for Luna/u);
      assert.equal(
        renderedNodes(setup.renderer.root).filter((node) =>
          node.id.startsWith("choice-"),
        ).length,
        2,
      );
      assert.match(setup.captureCharFrame(), /▶ Model default/u);
      assert.match(setup.captureCharFrame(), /low/u);
      await pressEscape(setup);
      assert.equal(context.input.focused, true);
      assert.equal(context.hostCloses, 0);
    },
    {
      expectedWatchCalls: 1,
      expectedCloseCalls: 1,
      preferences: {
        listModels: () => [
          {
            providerId: "openai",
            providerName: "OpenAI",
            id: "gpt-5.6-luna",
            name: "Luna",
            reasoning: ["low"],
          },
        ],
      },
    },
  );
});

test("choosing a model returns keyboard focus to the composer without Escape", async () => {
  await withCli(
    async ({ setup, input, type, submit }) => {
      await type("/model");
      await submit();
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("SIGNED IN")),
      );
      assert.match(setup.captureCharFrame(), /DEFAULT/u);
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("OpenAI · Luna")),
      );
      await act(async () => setup.mockInput.pressArrow("down"));
      await act(async () => setup.mockInput.pressEnter());
      await act(async () =>
        setup.waitForFrame((frame) => !frame.includes("OpenAI · Luna")),
      );
      await act(async () => setup.mockInput.typeText("new instruction"));
      assert.equal(input.focused, true);
      assert.equal(input.plainText, "new instruction");
    },
    {
      preferences: {
        listModels: () => [
          {
            providerId: "openai",
            providerName: "OpenAI",
            id: "gpt-5.6-luna",
            name: "Luna",
            reasoning: [],
          },
        ],
      },
    },
  );
});

test("Enter immediately after a long bracketed paste submits that complete draft", async () => {
  await withCli(async ({ setup, requests }) => {
    const pasted = `Review these lines: ${"quoted (value) and context ".repeat(40)}`;
    assert.ok(pasted.length > 700);
    await act(async () => {
      void setup.mockInput.pasteBracketedText(pasted);
      setup.mockInput.pressEnter();
    });
    await act(async () => setup.renderOnce());
    assert.deepEqual(
      requests
        .filter((request) => request.type === "prompt")
        .map((request) => request.text),
      [pasted],
    );
  });
});

test("a disconnected session retries its watch and recovers without /reconnect", async () => {
  let attempts = 0;
  const reconnected = Promise.withResolvers();
  await withCli(
    async ({ setup }) => {
      // The first retry comes within a fraction of a second, so the failed
      // watch's banner may already be gone; the retry itself is the proof.
      await act(async () => reconnected.promise);
      // Query observers notify on their own scheduler after the watch opens.
      // Poll the rendered recovery outcome, bounded independently of that scheduler.
      await waitForFrame(
        setup,
        (frame) =>
          !/Session stream is unavailable|offline|disconnected/u.test(frame),
      );
      assert.doesNotMatch(setup.captureCharFrame(), /offline|disconnected/u);
      assert.equal(attempts, 2);
    },
    {
      watch: async (originalWatch) => {
        attempts += 1;
        if (attempts === 1) throw new Error("Session stream is unavailable");
        const watch = await originalWatch();
        return {
          ...watch,
          changes: (async function* () {
            reconnected.resolve();
            yield* watch.changes;
          })(),
        };
      },
      expectedWatchCalls: 1,
    },
  );
});

test("help and slash discovery follow live Whistle contributions", async () => {
  await withCli(async ({ setup, commands, fixture, type, submit }) => {
    let invoked = 0;
    const lease = await act(async () =>
      commands.contribute({
        sourceId: "command-test",
        namespace: "test",
        commands: [
          {
            id: "probe",
            title: "A contributed command",
            category: "Test",
            projections: { slash: { aliases: ["probe"] } },
            handler: () => {
              invoked += 1;
            },
          },
        ],
      }),
    );
    await type("/help");
    await submit();
    assert.equal(
      commands.snapshot().slash.some(({ alias }) => alias === "probe"),
      true,
    );
    await pressEscape(setup);
    await type("/pr");
    assert.match(setup.captureCharFrame(), /\/probe\s+A contributed command/u);
    await type("/probe");
    await submit();
    assert.equal(invoked, 1);
    assert.equal(fixture.promptCalls(), 0);
    await act(async () => lease.dispose());
    await act(async () => {
      void executeAlias(commands, "help", { origin: "slash" });
    });
    await act(async () => setup.renderOnce());
    assert.doesNotMatch(setup.captureCharFrame(), /\/probe/u);
    await pressEscape(setup);
  });
});

test("native startup recovery shows the error and Exit restores the terminal", async () => {
  const { renderTuiConnectionRecovery } =
    await import("@fungi.computer/spore/frame-renderer");
  const shown = Promise.withResolvers();
  const setup = await createTestRenderer({
    width: 72,
    height: 20,
    useKittyKeyboard: null,
  });
  const restoreActEnvironment = enterReactActEnvironment();
  let attempts = 0;
  let exitClient;
  const running = runTuiCli(
    { invocationRoot: "/fixture", databasePath: "/fixture/agent.sqlite" },
    {
      prepareClientExtensions: noOpClientExtensions,
      loadThemePreference: async () => ({ theme: "terminal" }),
      createRenderer: async () => setup.renderer,
      createServiceManager: () => ({
        connect: async () => {
          attempts++;
          throw new Error("Fixture service unavailable");
        },
      }),
      renderRecovery: (root, error, retry, exit) => {
        exitClient = exit;
        renderTuiConnectionRecovery(root, error, retry, exit);
        shown.resolve();
      },
    },
  );
  try {
    await act(async () => {
      await shown.promise;
    });
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    assert.match(frame, /Fixture service unavailable/u);
    assert.match(frame, /Retry connection/u);
    assert.match(frame, /Exit/u);
    await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => setup.mockInput.pressEnter());
    await act(async () => running);
    assert.equal(setup.renderer.isDestroyed, true);
    assert.equal(attempts, 1);
  } finally {
    try {
      await act(async () => {
        exitClient?.();
        await running;
      });
    } finally {
      restoreActEnvironment();
    }
  }
});

test("real Goal control renders one safe committed footer row", async () => {
  const payload = "safe\u001b]52;c;Y21k\u0007\u009d\u0090\u202e end";
  await withCli(
    async ({ setup, type, submit }) => {
      await type("/goal pause");
      await submit();
      await act(async () =>
        setup.waitForFrame((frame) =>
          frame.includes("Goal paused (/goal resume)"),
        ),
      );
      assert.match(
        setup.captureCharFrame(),
        /Goal paused \(\/goal resume\) · safe end/u,
      );
      assert.doesNotMatch(setup.captureCharFrame(), /Goal paused:/u);
      assert.doesNotMatch(
        setup.captureCharFrame(),
        /[^\P{Cc}\n\t]|[\u202a-\u202e\u2066-\u2069]/u,
      );
    },
    { goal: { revision: "test", objective: payload, state: "active" } },
  );
});
