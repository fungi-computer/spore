import assert from "node:assert/strict";
import { test } from "bun:test";
import { createWhistle } from "@fungi.computer/whistle";
import {
  AgentArchiveRefused,
  LocalAgentSelectionAmbiguous,
} from "@fungi.computer/truffle/service";
import { runTuiCli } from "../src/cli-runtime.js";
import { runFungiCli } from "../src/cli.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

const folder = "/project";
const agents = [
  {
    agentId: "local_store_first",
    databasePath: "/project/.fungi/agents/local_store_first/agent.sqlite",
    sessionCount: 1,
    updatedAt: 10,
  },
  {
    agentId: "local_store_second",
    databasePath: "/project/.fungi/agents/local_store_second/agent.sqlite",
    sessionCount: 0,
  },
];

function discovery(resume, bothHaveSessions, archived = []) {
  return {
    agents: agents.filter((agent) => !archived.includes(agent.agentId)),
    sessions: [
      {
        databasePath: agents[0].databasePath,
        sessionId: "first-talk",
        title: "first talk",
        createdAt: 1,
        updatedAt: 10,
        resume: () => resume("first-talk"),
      },
      ...(bothHaveSessions
        ? [
            {
              databasePath: agents[1].databasePath,
              sessionId: "second-talk",
              title: "second talk",
              createdAt: 1,
              updatedAt: 20,
              resume: () => resume("second-talk"),
            },
          ]
        : []),
    ],
    problems: [],
  };
}

async function launch({
  entry = "landing",
  picks,
  bothHaveSessions = false,
  refuse = [],
}) {
  const calls = [];
  const archivedIds = [];
  const notices = [];
  const rendered = [];
  let shown;
  const host = {
    sandboxStatus: async () => ({
      state: "available",
      requireSandbox: false,
    }),
    agentId: "agent",
    sessionId: "session",
    databasePath: agents[1].databasePath,
    session: {},
    close: async () => undefined,
  };
  await runTuiCli(
    { invocationRoot: folder, entry },
    {
      loadThemePreference: async () => ({ theme: "mocha" }),
      createServiceManager: () => ({
        models: async () => [],
        discover: async () =>
          discovery(
            (name) => {
              calls.push(`resume:${name}`);
              return Promise.resolve(host);
            },
            bothHaveSessions,
            archivedIds,
          ),
        archive: async (request) => {
          calls.push(`archive:${request.agentId}`);
          const refusal = refuse.shift();
          if (refusal !== undefined) throw refusal;
          archivedIds.push(request.agentId);
        },
        connect: async () => {
          calls.push("connect");
          return host;
        },
        createSession: async (creation) => {
          calls.push(`create:${creation.databasePath}`);
          return host;
        },
      }),
      prepareClientExtensions: noOpClientExtensions,
      createWhistle,
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({ destroy: () => undefined }),
      createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      renderConnecting: () => undefined,
      renderLanding: (
        _root,
        sessions,
        _folder,
        choose,
        _theme,
        shown,
        notice,
      ) => {
        notices.push(notice);
        rendered.push({
          sessions: sessions.map((session) => session.sessionId),
          agents: shown.map((agent) => agent.agentId),
        });
        choose(picks.shift());
      },
      renderRecovery: (_root, error, _retry, exit) => {
        shown = error;
        exit();
      },
      render: (_root, _query, _session, _commands, exit) => {
        exit();
      },
    },
  );
  return { calls, rendered, shown, notices };
}

test("pick in the main screen: a folder with several Agents lists them, and a new Session goes into the chosen Agent's store", async () => {
  const { calls, rendered } = await launch({
    picks: [{ kind: "agent", index: 1 }, { kind: "new" }],
  });
  assert.deepEqual(rendered, [
    { sessions: [], agents: ["local_store_first", "local_store_second"] },
    { sessions: [], agents: ["local_store_second"] },
  ]);
  assert.deepEqual(calls, [`create:${agents[1].databasePath}`]);
});

test("pick in the main screen: the chosen Agent's conversations open", async () => {
  const { calls, rendered } = await launch({
    picks: [
      { kind: "agent", index: 0 },
      { kind: "resume", index: 0 },
    ],
  });
  assert.deepEqual(rendered[1], {
    sessions: ["first-talk"],
    agents: ["local_store_first"],
  });
  assert.deepEqual(calls, ["resume:first-talk"]);
});

test("archive from the landing picker: the highlighted Agent leaves the list, nothing is deleted, and the person lands on the one left", async () => {
  const { calls, rendered } = await launch({
    picks: [{ kind: "archive", index: 0 }, { kind: "new" }],
  });
  assert.deepEqual(
    rendered.map((view) => view.agents),
    [["local_store_first", "local_store_second"], ["local_store_second"]],
  );
  assert.deepEqual(calls, [
    "archive:local_store_first",
    `create:${agents[1].databasePath}`,
  ]);
});

test("archive from the landing picker is refused while the Agent has a running command, and the picker says why", async () => {
  const picks = [
    { kind: "archive", index: 1 },
    { kind: "agent", index: 1 },
    { kind: "new" },
  ];
  const refuse = [
    new AgentArchiveRefused(
      "running",
      "command command_9 is running; cancel it first",
    ),
  ];
  const { calls, rendered, notices } = await launch({ picks, refuse });
  assert.deepEqual(
    rendered.map((view) => view.agents),
    [
      ["local_store_first", "local_store_second"],
      ["local_store_first", "local_store_second"],
      ["local_store_second"],
    ],
  );
  assert.deepEqual(notices, [
    undefined,
    "command command_9 is running; cancel it first",
    undefined,
  ]);
  assert.deepEqual(calls, [
    "archive:local_store_second",
    `create:${agents[1].databasePath}`,
  ]);
});

test("any archive failure shows as a notice on the landing and never exits it", async () => {
  const { calls, rendered, notices } = await launch({
    picks: [
      { kind: "archive", index: 0 },
      { kind: "agent", index: 1 },
      { kind: "new" },
    ],
    refuse: [new Error("SQLITE_ERROR: no such column: archived")],
  });
  assert.deepEqual(rendered.map((view) => view.agents).slice(0, 2), [
    ["local_store_first", "local_store_second"],
    ["local_store_first", "local_store_second"],
  ]);
  assert.deepEqual(notices.slice(0, 2), [
    undefined,
    "SQLITE_ERROR: no such column: archived",
  ]);
  assert.deepEqual(calls, [
    "archive:local_store_first",
    `create:${agents[1].databasePath}`,
  ]);
});

test("an abort during an archive ends the selection instead of showing a notice", async () => {
  const { calls, shown } = await launch({
    picks: [{ kind: "archive", index: 0 }],
    refuse: [new globalThis.DOMException("aborted", "AbortError")],
  });
  assert.deepEqual(calls, ["archive:local_store_first"]);
  assert.equal(shown?.name, "AbortError");
});

test("fungi new with several Agents that all have conversations asks which Agent instead of using the newest store", async () => {
  const { calls, shown } = await launch({
    entry: "new",
    bothHaveSessions: true,
    picks: [],
  });
  assert.deepEqual(calls, []);
  assert.match(shown?.message ?? "", /local_store_first, local_store_second/u);
});

test("Esc on one Agent's conversations goes back to the Agent list; Esc there quits", async () => {
  const { calls, rendered } = await launch({
    picks: [
      { kind: "agent", index: 0 },
      undefined,
      { kind: "agent", index: 1 },
      { kind: "new" },
    ],
  });
  assert.deepEqual(
    rendered.map((view) => view.agents),
    [
      ["local_store_first", "local_store_second"],
      ["local_store_first"],
      ["local_store_first", "local_store_second"],
      ["local_store_second"],
    ],
  );
  assert.deepEqual(calls, [`create:${agents[1].databasePath}`]);
});

test("fungi new with several Agents and no conversations shows the Agents in the recovery screen", async () => {
  let shown;
  await runTuiCli(
    { invocationRoot: folder, entry: "new" },
    {
      loadThemePreference: async () => ({ theme: "mocha" }),
      createServiceManager: () => ({
        models: async () => [],
        discover: async () => ({ agents, sessions: [], problems: [] }),
      }),
      prepareClientExtensions: noOpClientExtensions,
      createWhistle,
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({ destroy: () => undefined }),
      createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      renderConnecting: () => undefined,
      renderRecovery: (_root, error, _retry, exit) => {
        shown = error;
        exit();
      },
    },
  );
  assert.match(shown?.message ?? "", /local_store_first, local_store_second/u);
});

function runWith(args, connect) {
  const selections = [];
  const run = runFungiCli(
    ["run", "hi", "-C", folder, ...args],
    { stdin: [], stdout: { write: () => true } },
    {
      createServiceManager: () => ({
        discover: async () => ({ agents, sessions: [], problems: [] }),
        connect: async (selection) => {
          selections.push(selection);
          return connect(selection);
        },
      }),
    },
  );
  return { run, selections };
}

test("fungi run without --agent in a folder with several Agents lists them and the flag", async () => {
  const { run } = runWith([], () =>
    Promise.reject(
      new LocalAgentSelectionAmbiguous(agents.map((agent) => agent.agentId)),
    ),
  );
  await assert.rejects(run, /local_store_first, local_store_second.*--agent/su);
});

test("fungi run --agent <id> runs against that Agent's store", async () => {
  const { run, selections } = runWith(["--agent", "local_store_second"], () =>
    Promise.reject(new Error("stop after selection")),
  );
  await assert.rejects(run, /stop after selection/u);
  assert.equal(selections[0].databasePath, agents[1].databasePath);
});

test("fungi run --agent with an unknown id names the Agents that exist", async () => {
  const { run, selections } = runWith(["--agent", "nobody"], () =>
    Promise.reject(new Error("must not connect")),
  );
  await assert.rejects(
    run,
    /No Agent nobody.*local_store_first, local_store_second/su,
  );
  assert.deepEqual(selections, []);
});

test("--agent is only valid with fungi run and not with --db", async () => {
  await assert.rejects(
    runFungiCli(["resume", "--agent", "x"]),
    /--agent is only valid with fungi run/u,
  );
  await assert.rejects(
    runFungiCli(["run", "hi", "--agent", "x", "--db", "y"]),
    /cannot be combined/u,
  );
});
