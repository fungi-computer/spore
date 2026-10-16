import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { spawn } from "bun";
import { mock } from "bun:test";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle/service";

const { capturePrivateLocalExecPath } = await import(
  new URL(
    "./private-local-exec-path.js",
    import.meta.resolve("@fungi.computer/truffle"),
  ).href
);
const clientPath = capturePrivateLocalExecPath(
  process.env.PATH ?? "/usr/bin:/bin",
  process.cwd(),
);

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "fungi-installed-cli-"));
const serviceDirectory = join(root, ".fungi", "service");
const measurements = [];
async function invoke(args, extraEnv = {}) {
  const started = globalThis.performance.now();
  const child = spawn([process.execPath, cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PATH: clientPath,
      HOME: root,
      USERPROFILE: root,
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), 30_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new globalThis.Response(child.stdout).text(),
      new globalThis.Response(child.stderr).text(),
    ]);
    measurements.push({
      args,
      exit,
      milliseconds: globalThis.performance.now() - started,
    });
    return { exit, stdout, stderr };
  } finally {
    clearTimeout(deadline);
  }
}

const loadBefore = loadavg();
const heldRun = Promise.withResolvers();
const releaseRun = Promise.withResolvers();
let modelCalls = 0;
let hookCode;
let hookModelCalls = 0;
let homeModelCalls = 0;
await mkdir(serviceDirectory, { recursive: true });
let serviceRun;
let owner;
let reopened;
let failure;
const manager = createPrivateLocalServiceManager({
  directory: serviceDirectory,
  executionPath: clientPath,
});
try {
  for (const args of [["--help"], ["-h"]]) {
    const result = await invoke(args);
    assert.equal(result.exit, 0, result.stderr);
    assert.match(result.stdout, /Usage: fungi/u);
  }
  for (const args of [
    ["not-a-command"],
    ["--not-an-option"],
    ["run", "one", "two"],
  ]) {
    const result = await invoke(args);
    assert.equal(result.exit, 1, result.stderr);
    assert.match(
      result.stderr,
      /Unknown fungi command|Unknown option|at most one prompt/u,
    );
  }

  // Retain the native package proof's deterministic provider boundary. The owner,
  // SQLite, admission, observation and child CLI are the installed implementation.
  const model = {
    id: "gpt-6-luna",
    name: "Installed CLI proof",
    api: "private-local-proof",
    provider: "openai",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1_024,
  };
  const answer = "INSTALLED_CLI_OK";
  function fixtureReply(context) {
    if (JSON.stringify(context).includes("Prove Home direct files")) {
      homeModelCalls += 1;
      const system = context.messages.find(({ role }) => role === "system");
      for (const name of ["read", "list", "glob", "grep", "apply_patch"])
        assert.ok(system?.toolsAdded?.some((tool) => tool.name === name));
      const previous = context.messages.at(-1);
      if (homeModelCalls > 1) {
        assert.equal(previous?.role, "toolResult");
        assert.equal(previous.isError, false);
      }
      if (homeModelCalls === 2)
        assert.match(JSON.stringify(previous.content), /before/u);
      return homeModelCalls < 3
        ? {
            held: false,
            reason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: `home-direct-${homeModelCalls}`,
                name: homeModelCalls === 1 ? "read" : "apply_patch",
                arguments:
                  homeModelCalls === 1
                    ? { path: "daily.txt" }
                    : {
                        patch:
                          "*** Begin Patch\n*** Update File: daily.txt\n@@\n-before\n+after\n*** End Patch",
                      },
              },
            ],
          }
        : {
            held: false,
            reason: "stop",
            content: [{ type: "text", text: "HOME_DIRECT_FILES_OK" }],
          };
    }
    if (
      hookCode !== undefined &&
      JSON.stringify(context).includes("Prove the Git hook PATH")
    ) {
      hookModelCalls += 1;
      return hookModelCalls === 1
        ? {
            held: false,
            reason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "hook-path-call",
                name: "execute",
                arguments: { code: hookCode },
              },
            ],
          }
        : {
            held: false,
            reason: "stop",
            content: [{ type: "text", text: "HOOK_PROOF_OK" }],
          };
    }
    modelCalls += 1;
    return {
      held: modelCalls === 2,
      reason: "stop",
      content: [{ type: "text", text: answer }],
    };
  }
  const localEntry = import.meta.resolve("@fungi.computer/truffle");
  await mock.module(new URL("./local-models.js", localEntry).href, () => ({
    listPrivateModels: () => [
      {
        providerId: model.provider,
        providerName: "Fixture",
        id: model.id,
        name: model.name,
        reasoning: [],
      },
    ],
    createPrivateModels: () => ({
      getModel: () => model,
      getProvider: () => ({ id: model.provider, name: "Fixture" }),
      checkAuth: async () => ({ type: "oauth", source: "Fixture login" }),
      streamSimple: (_selected, context) => {
        const reply = fixtureReply(context);
        if (reply.held) heldRun.resolve();
        const message = {
          role: "assistant",
          content: reply.content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: reply.reason,
          timestamp: Date.now(),
        };
        return {
          async *[Symbol.asyncIterator]() {
            if (reply.held) await releaseRun.promise;
            yield {
              type: "done",
              reason: message.stopReason,
              message: await Promise.resolve(message),
            };
          },
          result: () => Promise.resolve(message),
        };
      },
    }),
  }));
  const { runPrivateLocalService } = await import(
    new URL("./private-local-service-listener.js", localEntry).href
  );
  const { openPrivateLocalRuntimeHost } = await import(
    new URL("./private-local-runtime-host.js", localEntry).href
  );
  serviceRun = runPrivateLocalService(serviceDirectory, (options) =>
    openPrivateLocalRuntimeHost({
      ...options,
      providerId: model.provider,
      modelId: model.id,
    }),
  );
  await Promise.race([
    (async () => {
      for (
        let attempt = 0;
        attempt < 100 && (await manager.status()) === undefined;
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(
        await manager.status(),
        "persistent Local service did not start",
      );
    })(),
    serviceRun.then(() => {
      throw new Error("persistent Local service exited before it was ready");
    }),
  ]);
  const result = await invoke(["run", "Prove the installed client."]);
  assert.equal(result.exit, 0, result.stderr);
  assert.match(result.stdout, /INSTALLED_CLI_OK/u);
  owner = await manager.connect({ invocationRoot: root });
  const snapshot = await owner.session.read();
  assert.equal(snapshot.activity.queue.state, "idle");
  assert.equal(snapshot.pending.prompts.length, 0);
  assert(
    snapshot.messages.some(
      ({ value }) =>
        value.role === "assistant" &&
        value.content.some(
          (part) => part.type === "text" && part.text === answer,
        ),
    ),
  );
  await owner.close();
  assert.ok(
    await manager.status(),
    "closing the client must keep service alive",
  );
  reopened = await manager.connect({ invocationRoot: root });
  assert.equal(reopened.sessionId, owner.sessionId);
  assert.equal((await reopened.session.read()).activity.queue.state, "idle");
  const { proveServiceRecovery } = await import("./service-recovery.proof.mjs");
  await proveServiceRecovery({
    manager,
    root,
    owner: reopened,
    started: heldRun.promise,
    release: releaseRun.resolve,
  });

  await reopened.close();
  reopened = undefined;
  const homeProject = join(root, "home-project");
  await mkdir(homeProject);
  await writeFile(join(homeProject, "daily.txt"), "before\n");
  const homeResult = await invoke([
    "run",
    "-C",
    homeProject,
    "Prove Home direct files",
  ]);
  assert.equal(homeResult.exit, 0, homeResult.stderr);
  assert.match(homeResult.stdout, /HOME_DIRECT_FILES_OK/u);
  assert.equal(
    await readFile(join(homeProject, "daily.txt"), "utf8"),
    "after\n",
  );
  assert.equal(homeModelCalls, 3);
  const repository = join(root, "hook-project");
  const remote = join(root, "hook-remote.git");
  const toolchain = join(root, "client-toolchain");
  const hookMarker = join(root, "hook-ran.txt");
  await mkdir(repository);
  await mkdir(toolchain);
  function git(args, cwd = root) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "-q", "--bare", remote]);
  git(["init", "-q", repository]);
  await writeFile(join(repository, "fixture.txt"), "fixture\n");
  git(["add", "fixture.txt"], repository);
  git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ],
    repository,
  );
  git(["remote", "add", "origin", remote], repository);
  const hook = join(repository, ".git", "hooks", "pre-push");
  await writeFile(hook, "#!/bin/sh\npnpm --version\n");
  await chmod(hook, 0o755);
  const pnpm = join(toolchain, "pnpm");
  await writeFile(pnpm, `#!/bin/sh\nprintf fixture-pnpm > '${hookMarker}'\n`);
  await chmod(pnpm, 0o755);
  hookCode =
    'async () => await env.computers.local.exec({command:"git push origin HEAD"})';
  const hookResult = await invoke(
    ["run", "-C", repository, "Prove the Git hook PATH"],
    {
      PATH: `${toolchain}:/usr/bin:/bin`,
    },
  );
  assert.equal(hookResult.exit, 0, hookResult.stderr);
  assert.match(hookResult.stdout, /HOOK_PROOF_OK/u);
  assert.equal(await readFile(hookMarker, "utf8"), "fixture-pnpm");
  assert.equal(
    git([
      "--git-dir",
      remote,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads",
    ]),
    git(["rev-parse", "HEAD"], repository),
  );
  assert.equal(git(["status", "--short"], repository), "");
  assert.equal(hookModelCalls, 2);
  process.stdout.write(
    JSON.stringify(
      {
        measurements,
        loadBefore,
        loadAfter: loadavg(),
        ownerClosed: true,
        homeDirectTools: { read: "passed", apply_patch: "passed" },
        provider: "deterministic fixture; no live model call",
      },
      null,
      2,
    ) + "\n",
  );
} catch (cause) {
  failure = cause;
}
releaseRun.resolve();
const cleanupFailures = [];
for (const close of [
  () => reopened?.close(),
  () => owner?.close(),
  async () => {
    if (serviceRun === undefined) return;
    await manager.stop();
    await serviceRun;
  },
]) {
  try {
    await close();
  } catch (cause) {
    cleanupFailures.push(cause);
  }
}
// Preserve disposable data if shutdown could not be collected.
if (cleanupFailures.length === 0)
  await rm(root, { recursive: true, force: true });
if (failure !== undefined || cleanupFailures.length > 0)
  throw new AggregateError(
    failure === undefined ? cleanupFailures : [failure, ...cleanupFailures],
    "Installed CLI proof or cleanup failed",
  );
