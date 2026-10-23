import assert from "node:assert/strict";
import { test } from "bun:test";
import { createWhistle } from "@fungi.computer/whistle";
import { runTuiCli } from "../src/cli-runtime.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

const host = {
  sandboxStatus: async () => ({
    state: "available",
    requireSandbox: false,
  }),
  agentId: "agent-landing",
  sessionId: "session-landing",
  databasePath: "/project/one/agent.sqlite",
  session: {},
  close: async () => undefined,
};

async function launch({
  entry = "landing",
  choice,
  empty = false,
  resume = false,
}) {
  const calls = [];
  let renderedFolder;
  const sessions = ["newest", "older"].map((name, index) => ({
    databasePath: "/project/one/agent.sqlite",
    sessionId: name,
    title: name,
    createdAt: 1,
    updatedAt: 10 - index,
    resume: async () => {
      calls.push(`resume:${name}`);
      return host;
    },
  }));
  await runTuiCli(
    { invocationRoot: "/project", entry, resume },
    {
      loadThemePreference: async () => ({ theme: "mocha" }),
      createServiceManager: () => ({
        models: async () => [],
        discover: async (folder) => {
          assert.equal(folder, "/project");
          return {
            agents: empty
              ? []
              : [
                  {
                    agentId: "one",
                    databasePath: "/project/one/agent.sqlite",
                    sessionCount: 1,
                  },
                ],
            sessions: empty ? [] : sessions,
            problems: [],
          };
        },
        connect: async (selection) => {
          assert.equal(selection.invocationRoot, "/project");
          calls.push("connect");
          return host;
        },
        createSession: async (creation) => {
          assert.equal(creation.databasePath, "/project/one/agent.sqlite");
          assert.equal(creation.invocationRoot, "/project");
          assert.ok(creation.requestId);
          calls.push("create");
          return host;
        },
      }),
      prepareClientExtensions: noOpClientExtensions,
      createWhistle,
      createQueryClient: () => ({ clear: () => undefined }),
      createRenderer: async () => ({ destroy: () => calls.push("destroy") }),
      createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      renderConnecting: () => undefined,
      renderLanding: (_root, choices, folder, choose) => {
        calls.push("landing");
        assert.equal(folder, "/project");
        assert.equal(choices.length, empty ? 0 : 2);
        choose(choice);
      },
      renderPicker: (_root, _sessions, select) => {
        calls.push("picker");
        select(0);
      },
      render: (_root, _query, _session, _commands, exit, _theme, controls) => {
        renderedFolder = controls.folder;
        exit();
      },
    },
  );
  if (
    calls.some(
      (call) =>
        call === "connect" || call === "create" || call.startsWith("resume:"),
    )
  )
    assert.equal(renderedFolder, "/project");
  return calls;
}

test("landing resumes the selected conversation", async () => {
  assert.deepEqual(await launch({ choice: { kind: "resume", index: 1 } }), [
    "landing",
    "resume:older",
    "destroy",
  ]);
});
test("landing creates one Session in the newest existing store", async () => {
  assert.deepEqual(await launch({ choice: { kind: "new" } }), [
    "landing",
    "create",
    "destroy",
  ]);
});
test("landing in an empty project connects once without creating a second Session", async () => {
  assert.deepEqual(await launch({ choice: { kind: "new" }, empty: true }), [
    "landing",
    "connect",
    "destroy",
  ]);
});
test("fungi new bypasses the landing and creates a Session", async () => {
  assert.deepEqual(await launch({ entry: "new" }), ["create", "destroy"]);
});
test("fungi new in an empty project connects once", async () => {
  assert.deepEqual(await launch({ entry: "new", empty: true }), [
    "connect",
    "destroy",
  ]);
});
test("Esc on the landing exits without opening a Session", async () => {
  assert.deepEqual(await launch({}), ["landing", "destroy"]);
});
test("in-TUI resume bypasses the landing", async () => {
  assert.deepEqual(await launch({ resume: true }), [
    "picker",
    "resume:newest",
    "destroy",
  ]);
});
