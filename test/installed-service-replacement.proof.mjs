// Two genuine installed bundles, an ordinary in-place local npm replacement,
// and the real sessions-resume entry in a PTY. No service/SDK overrides.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { URL } from "node:url";
import console from "node:console";
import process from "node:process";
import { Terminal as Emulator } from "@xterm/headless";
import { z } from "zod";
import { Terminal, serve, sleep, spawn, which } from "bun";

const [
  oldPrefixArgument,
  nextPrefixArgument,
  nextArchivesArgument,
  workArgument,
] = process.argv.slice(2);
assert.ok(
  oldPrefixArgument &&
    nextPrefixArgument &&
    nextArchivesArgument &&
    workArgument,
  "Pass owned old prefix, next prefix, next archive directory, and evidence directory",
);
const oldPrefix = resolve(oldPrefixArgument);
const nextPrefix = resolve(nextPrefixArgument);
const nextArchives = resolve(nextArchivesArgument);
const work = await mkdtemp(join(resolve(workArgument), "case-"));
const home = join(work, "home");
const runtime = join(work, "runtime");
const project = join(work, "project");
for (const path of [
  join(home, ".fungi"),
  project,
  join(work, "tmp"),
  join(work, "config"),
  join(work, "cache"),
  join(work, "data"),
  runtime,
])
  await mkdir(path, { recursive: true, mode: 0o700 });
await chmod(runtime, 0o700);
await writeFile(
  join(home, ".fungi/onboarding.json"),
  JSON.stringify({ version: 1, door: "later" }),
  { mode: 0o600 },
);
const node = which("node");
assert.ok(node, "The maintained Node launcher needs Node on PATH");
const environment = {
  HOME: home,
  USERPROFILE: home,
  TMPDIR: join(work, "tmp"),
  XDG_CONFIG_HOME: join(work, "config"),
  XDG_CACHE_HOME: join(work, "cache"),
  XDG_DATA_HOME: join(work, "data"),
  XDG_STATE_HOME: join(work, "state"),
  XDG_RUNTIME_DIR: runtime,
  NPM_CONFIG_USERCONFIG: "/dev/null",
  PATH: [
    join(oldPrefix, "node_modules/.bin"),
    dirname(node),
    "/usr/bin",
    "/bin",
  ].join(":"),
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  LANG: "C.UTF-8",
};
const launcher = join(oldPrefix, "node_modules/.bin/fungi");
const cli = (prefix) =>
  join(prefix, "node_modules/@fungi.computer/spore/dist/cli.js");
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const firstBuild = await hash(cli(oldPrefix));
const nextBuild = await hash(cli(nextPrefix));
assert.notEqual(firstBuild, nextBuild, "Replacement needs two real build IDs");
// Same hosted-model interface exercised by private-fungi-model-provider.test.ts;
// only the inference producer is held. The installed Local runtime is untouched.
const modelStarted = Promise.withResolvers();
const calls = [];
const encoder = new globalThis.TextEncoder();
const prompt = "BUSY_INSTALLED_REPLACEMENT_ONE_REQUEST";
const reply = "BUSY_INSTALLED_REPLACEMENT_FINISHED";
const hub = serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/teams/team-replacement/models")
      return globalThis.Response.json({
        object: "list",
        data: [
          {
            id: "@fungi/luna",
            owned_by: "fungi",
            name: "Held replacement fixture",
            context_window: 1_050_000,
            max_output_tokens: 128_000,
            reasoning_levels: [],
            input: ["text"],
            default: true,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
    if (path !== "/api/v1/teams/team-replacement/chat/completions")
      return new globalThis.Response("Not a fixture model endpoint", {
        status: 404,
      });
    const body = await request.json();
    assert.ok(JSON.stringify(body.messages).includes(prompt));
    const call = { at: Date.now(), cancelled: false };
    calls.push(call);
    const stream = new globalThis.ReadableStream({
      start(controller) {
        const emit = (value) =>
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
          );
        emit({
          id: "held-fixture-reply",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "IN_FLIGHT " },
              finish_reason: null,
            },
          ],
        });
        call.release = () => {
          if (call.cancelled) return;
          emit({
            id: "held-fixture-reply",
            choices: [
              { index: 0, delta: { content: reply }, finish_reason: null },
            ],
          });
          emit({
            id: "held-fixture-reply",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 1,
              total_tokens: 11,
            },
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          call.cancelled = true;
        };
        modelStarted.resolve();
      },
      cancel() {
        call.cancelled = true;
      },
    });
    request.signal.addEventListener(
      "abort",
      () => {
        call.cancelled = true;
      },
      { once: true },
    );
    return new globalThis.Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
});
await mkdir(join(home, ".config/fungi"), { recursive: true, mode: 0o700 });
await writeFile(
  join(home, ".config/fungi/credentials.json"),
  JSON.stringify({
    fungi: {
      type: "oauth",
      access: "owned-fixture-access",
      refresh: "owned-fixture-refresh",
      expires: Date.now() + 900_000,
      issuer: `http://127.0.0.1:${hub.port}`,
      team: {
        teamId: "team-replacement",
        handle: "replacement",
        name: "Owned fixture",
      },
      teamCount: 1,
    },
  }),
  { mode: 0o600 },
);
const record = async () =>
  JSON.parse(await readFile(join(home, ".fungi/service/service.json"), "utf8"));
async function run(command) {
  const child = spawn(command, {
    cwd: project,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new globalThis.Response(child.stdout).text(),
    new globalThis.Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, `${command[0]} failed: ${stderr}`);
  return stdout;
}
function open(args) {
  const emulator = new Emulator({
    cols: 120,
    rows: 36,
    scrollback: 0,
    allowProposedApi: true,
  });
  const observations = [];
  let armed = false;
  const terminal = new Terminal({
    cols: 120,
    rows: 36,
    data: (_terminal, bytes) =>
      emulator.write(bytes, () => {
        if (!armed) return;
        const frame = text();
        if (
          frame.includes("Session stream is unavailable") ||
          frame.includes("Reconnecting to the service") ||
          frame.includes("The service is busy") ||
          frame.includes("The service stopped") ||
          frame.includes("The service is not answering")
        )
          observations.push({ at: Date.now(), frame });
      }),
  });
  const child = spawn([launcher, ...args, "-C", project], {
    cwd: project,
    env: environment,
    terminal,
  });
  const text = () =>
    Array.from(
      { length: 36 },
      (_, row) =>
        emulator.buffer.active.getLine(row)?.translateToString(true) ?? "",
    ).join("\n");
  return {
    emulator,
    terminal,
    child,
    text,
    observations,
    arm: () => {
      armed = true;
    },
  };
}
async function discovery(service) {
  const response = await globalThis.fetch(
    `${service.baseUrl}/service/${service.serviceId}/discover`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invocationRoot: project }),
      redirect: "error",
    },
  );
  assert.equal(response.status, 200);
  return response.json();
}
async function inspect(service, session) {
  const response = await globalThis.fetch(
    `${service.baseUrl}/service/${service.serviceId}/inspect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invocationRoot: project,
        sessionId: session.sessionId,
        databasePath: session.databasePath,
        limit: 100,
      }),
      redirect: "error",
    },
  );
  assert.equal(response.status, 200);
  return response.json();
}
async function until(opened, description, predicate, budget = 5_000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline && opened.child.exitCode === null) {
    if (predicate(opened.text())) return;
    await sleep(50);
  }
  await writeFile(join(work, "failure-screen.txt"), opened.text(), {
    mode: 0o600,
  });
  assert.ok(predicate(opened.text()), description);
}
async function close(opened) {
  opened.terminal.write("\x03");
  await Promise.race([opened.child.exited, sleep(1_500)]);
  if (opened.child.exitCode === null) {
    opened.terminal.write("\x03");
    await Promise.race([opened.child.exited, sleep(1_500)]);
  }
  if (opened.child.exitCode === null) opened.child.kill();
  await opened.child.exited;
  opened.terminal.close();
  opened.emulator.dispose();
}
let opened;
const evidence = {
  work,
  firstBuild,
  nextBuild,
  idleReexecDraftContinuity: "expected until UPDATE lands",
};
try {
  opened = open(["new"]);
  await until(opened, "Initial owned Session did not open", (text) =>
    text.includes("Ask anything"),
  );
  await close(opened);
  opened = undefined;
  const before = JSON.parse(
    await run([
      launcher,
      "sessions",
      "status",
      "--last",
      "--json",
      "-C",
      project,
    ]),
  );
  evidence.before = before;
  opened = open(["sessions", "resume", "--last"]);
  await until(opened, "Actual sessions-resume entry did not open", (text) =>
    text.includes("Ask anything"),
  );
  evidence.firstRecord = await record();
  assert.equal(evidence.firstRecord.version, firstBuild);
  evidence.firstDiscovery = await discovery(evidence.firstRecord);
  assert.equal(evidence.firstDiscovery.agents.length, 1);
  const agentId = z
    .string()
    .min(1)
    .parse(evidence.firstDiscovery.agents[0].agentId);
  z.string().min(1).parse(before.sessionId);
  assert.equal(before.activity.queue.state, "idle");
  opened.terminal.write(`${prompt}\r`);
  await Promise.race([
    modelStarted.promise,
    sleep(5_000).then(() => {
      throw new Error("Real model-call admission barrier was not reached");
    }),
  ]);
  const selected = evidence.firstDiscovery.sessions.find(
    (item) => item.sessionId === before.sessionId,
  );
  assert.ok(selected);
  evidence.inFlight = await inspect(evidence.firstRecord, selected);
  assert.equal(evidence.inFlight.snapshot.activity.queue.state, "running");
  const submitted = evidence.inFlight.snapshot.messages.filter(
    ({ value }) => value.role === "user",
  );
  assert.equal(submitted.length, 1);
  const commandId = z.string().min(1).parse(submitted[0].commandId);
  assert.equal(evidence.inFlight.snapshot.terminals.length, 0);
  await writeFile(join(work, "before.txt"), opened.text(), { mode: 0o600 });
  opened.arm();
  const replacementStarted = Date.now();
  await run([
    "npm",
    "install",
    "--prefix",
    oldPrefix,
    "--cache",
    join(resolve(workArgument), "npm-cache"),
    "--no-audit",
    "--no-fund",
    join(nextArchives, "fungi.computer-spore-0.1.1.tgz"),
    join(nextArchives, "fungi.computer-spore-native-linux-x64-0.1.1.tgz"),
  ]);
  assert.equal(await hash(cli(oldPrefix)), nextBuild);
  await run([launcher, "sessions", "list", "-C", project]);
  evidence.replacementRecord = await record();
  assert.equal(evidence.replacementRecord.version, nextBuild);
  assert.notEqual(
    evidence.firstRecord.serviceId,
    evidence.replacementRecord.serviceId,
  );
  assert.notEqual(
    new URL(evidence.firstRecord.baseUrl).port,
    new URL(evidence.replacementRecord.baseUrl).port,
  );
  evidence.postReplacement = await inspect(
    evidence.replacementRecord,
    selected,
  );
  await until(
    opened,
    "Busy installed replacement did not reconnect to a fresh snapshot",
    (text) =>
      opened.observations.length > 0 &&
      text.includes("IN_FLIGHT") &&
      !text.includes("Session stream is unavailable") &&
      !text.includes("Reconnecting to the service") &&
      !text.includes("The service is busy") &&
      !text.includes("The service stopped") &&
      !text.includes("The service is not answering"),
  );
  evidence.observations = opened.observations;
  for (const call of calls) call.release();
  const settlementDeadline = Date.now() + 5_000;
  do {
    evidence.settlement = await inspect(evidence.replacementRecord, selected);
    if (
      evidence.settlement.snapshot.terminals.some(
        (terminal) => terminal.commandId === commandId,
      )
    )
      break;
    await sleep(50);
  } while (Date.now() < settlementDeadline);
  assert.equal(
    evidence.settlement.snapshot.terminals.filter(
      (terminal) => terminal.commandId === commandId,
    ).length,
    1,
  );
  assert.equal(
    evidence.settlement.snapshot.messages.filter(
      ({ value }) => value.role === "user",
    ).length,
    1,
  );
  evidence.after = JSON.parse(
    await run([
      launcher,
      "sessions",
      "status",
      "--last",
      "--json",
      "-C",
      project,
    ]),
  );
  assert.equal(evidence.after.sessionId, before.sessionId);
  evidence.replacementDiscovery = await discovery(evidence.replacementRecord);
  assert.equal(evidence.replacementDiscovery.agents.length, 1);
  assert.equal(evidence.replacementDiscovery.agents[0].agentId, agentId);
  evidence.milliseconds = Date.now() - replacementStarted;
  await writeFile(join(work, "after.txt"), opened.text(), { mode: 0o600 });
  console.log("INSTALLED_REPLACEMENT_PASS", JSON.stringify(evidence));
} catch (cause) {
  evidence.failure = cause instanceof Error ? cause.message : String(cause);
  evidence.observations = opened?.observations;
  for (const call of calls) call.release();
  if (
    evidence.replacementRecord !== undefined &&
    evidence.firstDiscovery !== undefined
  ) {
    const selected = evidence.firstDiscovery.sessions[0];
    const deadline = Date.now() + 5_000;
    do {
      evidence.settlementAfterFailure = await inspect(
        evidence.replacementRecord,
        selected,
      );
      if (evidence.settlementAfterFailure.snapshot.terminals.length > 0) break;
      await sleep(50);
    } while (Date.now() < deadline);
  }
  throw cause;
} finally {
  if (opened !== undefined) await close(opened);
  await run([launcher, "stop"]);
  await hub.stop(true);
  evidence.modelCalls = calls.map(({ at, cancelled }) => ({ at, cancelled }));
  await writeFile(
    join(work, "evidence.json"),
    JSON.stringify(evidence, undefined, 2),
    { mode: 0o600 },
  );
  console.log("Owned installed proof evidence:", work);
}
