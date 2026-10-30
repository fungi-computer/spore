import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createWhistle } from "@fungi.computer/whistle";
import {
  localExecRules,
  manageLocalExecRules,
} from "@fungi.computer/truffle/rules";
import { runTuiCli } from "../src/cli-runtime.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";

test("permission controls use the selected Agent and project; navigation keeps the person's newer mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-permission-source-"));
  const project = join(root, "project");
  const other = join(root, "other");
  await Promise.all([mkdir(project), mkdir(other)]);
  localExecRules(project).add(["git", "push"]);
  localExecRules(other).add(["git", "push"]);
  const databasePath = join(
    project,
    ".fungi",
    "agents",
    "current",
    "agent.sqlite",
  );
  const selections = [];
  let mode = "workspace";
  let temporaryClosed = 0;
  let originalClosed = 0;
  let controls;
  let firstSource;
  let work;
  const signal = new globalThis.AbortController().signal;
  try {
    await runTuiCli(
      {
        invocationRoot: project,
        databasePath,
        sessionId: "main",
        mode: "workspace",
      },
      {
        loadThemePreference: async () => ({ theme: "mocha" }),
        createServiceManager: () => ({
          models: async () => [],
          connect: async (selection) => {
            selections.push(selection);
            assert.equal(selection.invocationRoot, project);
            assert.equal(selection.databasePath, databasePath);
            if (selection.mode !== undefined) mode = selection.mode;
            const temporary = selections.length === 2;
            const original = selections.length === 1;
            return {
              agentId: "agent-current",
              databasePath,
              sessionId: selection.sessionId,
              session: {},
              sandboxStatus: async () => ({ mode, available: true }),
              close: async () => {
                if (temporary) temporaryClosed++;
                if (original) originalClosed++;
              },
            };
          },
        }),
        prepareClientExtensions: noOpClientExtensions,
        createWhistle,
        createQueryClient: () => ({ clear: () => undefined }),
        createRenderer: async () => ({ destroy: () => undefined }),
        createRoot: () => ({
          render: () => undefined,
          unmount: () => undefined,
        }),
        renderConnecting: () => undefined,
        render: (_root, _query, _session, _commands, exit, _theme, next) => {
          controls = next;
          if (work !== undefined) return;
          firstSource = next.sandboxSource;
          work = (async () => {
            assert.ok(firstSource);
            await firstSource.setMode("read-only", signal);
            assert.equal(temporaryClosed, 1);
            assert.equal(originalClosed, 0);
            assert.equal((await firstSource.read(signal)).mode, "read-only");
            assert.equal(selections[1].sessionId, "main");
            assert.deepEqual(await firstSource.rules.list(signal), [
              ["git", "push"],
            ]);
            await firstSource.rules.remove(["git", "push"], signal);
            assert.deepEqual(manageLocalExecRules(project, "list"), []);
            assert.deepEqual(manageLocalExecRules(other, "list"), [
              ["git", "push"],
            ]);
            await next.onForked("fork", "current-pane");
            assert.equal(
              (await controls.sandboxSource.read(signal)).mode,
              "read-only",
            );
            assert.deepEqual(
              selections.map((selection) => selection.mode),
              ["workspace", "read-only", undefined],
            );
          })();
          void work.then(
            () => exit(),
            () => exit(),
          );
        },
      },
    );
    assert.ok(work);
    await work;
    assert.equal(originalClosed, 1);
    await assert.rejects(
      firstSource.setMode("full-access", signal),
      /selected Agent changed/u,
    );
    await assert.rejects(
      firstSource.rules.remove(["git", "push"], signal),
      /selected Agent changed/u,
    );
    assert.equal(selections.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
