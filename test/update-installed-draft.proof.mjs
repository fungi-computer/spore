import assert from "node:assert/strict";
import console from "node:console";
import { spawn, sleep, which } from "bun";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { z } from "zod";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle/service";
import { openLocalTerminal } from "../src/button/local-terminal.js";
import { runFungiReleaseUpdate } from "../src/update.js";
import { hasLiveReplacementDraft } from "./fixtures/update-installed-observation.mjs";

const require = createRequire(import.meta.url);
const repository = resolve(import.meta.dir, "../../..");
const work = await mkdtemp(join(repository, ".botanical/update-installed-"));
const home = join(work, "home");
const project = join(work, "project");
const prefix = join(work, "prefix");
const installed = join(prefix, "lib/node_modules/@fungi.computer/spore");
const launcher = join(installed, "dist/fungi.cjs");
const cli = join(installed, "dist/cli.js");
const bin = join(work, "bin");
const gate = join(work, "installed.ready");
const trace = join(work, "processes.jsonl");
const sourceNode = await realpath(which("node"));
const node = join(bin, "node");
const preload = fileURLToPath(
  new URL("./fixtures/update-registry-preload.mjs", import.meta.url),
);
const savedEnvironment = { ...process.env };
const recordSchema = z.object({
  pid: z.number(),
  version: z.string(),
  serviceId: z.string(),
  baseUrl: z.string(),
});
const readRecord = async () =>
  recordSchema.parse(
    JSON.parse(
      await readFile(join(home, ".fungi/service/service.json"), "utf8"),
    ),
  );
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
let terminal;
let connected;
let before;
let after;
const receipts = [];
const frame = () =>
  terminal
    .read()
    .rows.map((row) => row.map((cell) => cell.text).join(""))
    .join("\n");
async function until(label, check, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      await writeFile(join(work, "failed-frame.txt"), frame());
      throw new Error(`${label} timed out; evidence: ${work}`);
    }
    await sleep(15);
  }
}
async function capture(label, rendered = frame()) {
  const path = join(work, `${label}.txt`);
  await writeFile(path, rendered);
  receipts.push({ label, at: new Date().toISOString(), path });
}
async function invoke(args, env = process.env) {
  const child = spawn(args, {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new globalThis.Response(child.stdout).text(),
    new globalThis.Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, stderr);
  return { code, stdout, stderr };
}

try {
  await mkdir(home, { recursive: true });
  await mkdir(project);
  await mkdir(bin);
  // The launcher reports process.execPath. Keep Node beside the isolated npm
  // probe so managerEnvironment's Node-directory preference cannot reach a
  // developer's real package-manager installation.
  await copyFile(sourceNode, node);
  await chmod(node, 0o755);
  await cp(join(repository, ".botanical/fungi-cli-package"), installed, {
    recursive: true,
  });
  for (const name of ["@opentui/core", "@opencode-ai/pty", "miniflare"]) {
    const target = join(installed, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(
      await realpath(
        join(
          repository,
          name === "miniflare"
            ? "runtimes/local/node_modules"
            : "apps/tui/node_modules",
          name,
        ),
      ),
      target,
    );
  }
  const bunRequire = createRequire(require.resolve("bun/package.json"));
  const ptyRequire = createRequire(require.resolve("@opencode-ai/pty"));
  for (const [name, source] of [
    [
      "@oven/bun-linux-x64",
      dirname(bunRequire.resolve("@oven/bun-linux-x64/package.json")),
    ],
    [
      "@opencode-ai/pty-linux-x64-gnu",
      dirname(
        ptyRequire.resolve("@opencode-ai/pty-linux-x64-gnu/package.json"),
      ),
    ],
    [
      "@fungi.computer/spore-native-linux-x64",
      join(repository, ".botanical/fungi-cli-native-linux-x64"),
    ],
  ]) {
    const target = join(installed, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target);
  }
  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  // Two disposable releases of the current implementation. A content change
  // gives the real launcher a different build identity, without editing source.
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({ ...manifest, version: "0.1.0" }),
  );
  await appendFile(cli, "\n// isolated previous-release identity\n");
  // npm's bin-link step makes installed entrypoints executable.
  await chmod(launcher, 0o755);
  const oldBuild = await hash(cli);
  const newBuild = await hash(
    join(repository, ".botanical/fungi-cli-package/dist/cli.js"),
  );
  assert.notEqual(oldBuild, newBuild);
  await symlink(launcher, join(bin, "fungi"));
  // Only manager discovery is simulated; installation below uses the injected
  // package-runner boundary and copies only into this disposable prefix.
  await writeFile(
    join(bin, "npm"),
    `#!${node}\nimport fs from "node:fs";\nconst args=process.argv.slice(2);\nif(args[0]==="root"){const end=Date.now()+4500;while(!fs.existsSync(${JSON.stringify(gate)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);console.log(${JSON.stringify(join(prefix, "lib/node_modules"))});}\nelse if(args[0]==="prefix")console.log(${JSON.stringify(prefix)});\nelse process.exit(1);\n`,
  );
  await chmod(join(bin, "npm"), 0o755);
  for (const name of ["pnpm", "bun"]) {
    await writeFile(
      join(bin, name),
      "#!/bin/sh\nprintf '/not-this-install\\n'\n",
    );
    await chmod(join(bin, name), 0o755);
  }
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}:${savedEnvironment.PATH}`,
    BUN_OPTIONS: `--preload=${preload}`,
    FUNGI_UPDATE_PROOF_TRACE: trace,
    FUNGI_UPDATE_PROOF_CLI: cli,
    FUNGI_BUNDLED_CLI: cli,
    FUNGI_BUNDLED_BUILD_ID: oldBuild,
  });
  const linkedLauncher = which("fungi", { PATH: process.env.PATH });
  assert.ok(linkedLauncher);
  assert.equal(await realpath(linkedLauncher), launcher);
  const manager = createPrivateLocalServiceManager({
    directory: join(home, ".fungi/service"),
  });
  // The ordinary first-Agent caller uses connect; createSession requires an
  // existing Agent database path and is only for another Session in that Agent.
  connected = await manager.connect({
    invocationRoot: project,
  });
  before = await readRecord();
  assert.equal(before.version, oldBuild);
  const originalAddress = connected.session.address;
  terminal = await openLocalTerminal({
    columns: 160,
    rows: 48,
    program: {
      command: [
        node,
        launcher,
        "sessions",
        "resume",
        connected.sessionId,
        "-C",
        project,
      ],
      cwd: project,
      env: {
        BUN_OPTIONS: process.env.BUN_OPTIONS,
        FUNGI_UPDATE_PROOF_TRACE: trace,
        FUNGI_UPDATE_PROOF_CLI: cli,
      },
    },
  });
  await until("old installed composer", () =>
    frame().includes("Sign in to start"),
  );
  terminal.write("Unsubmitted before update");
  await until("first draft", () =>
    frame().includes("Unsubmitted before update"),
  );
  await capture("before-update");
  const calls = [];
  await runFungiReleaseUpdate({
    install: { method: "npm", prefix, launcher, node, version: "0.1.0" },
    updates: join(home, ".fungi/updates"),
    registry: () => Promise.resolve("0.1.1"),
    notify: (message) => calls.push(message),
    run: async (command, env) => {
      if (command[0] === "npm") {
        assert.equal(command.at(-1), "@fungi.computer/spore@0.1.1");
        await cp(join(repository, ".botanical/fungi-cli-package"), installed, {
          recursive: true,
        });
        await chmod(launcher, 0o755);
        return { code: 0, stdout: "", stderr: "" };
      }
      assert.equal(command[0], node);
      assert.equal(command[1], launcher);
      const result = await invoke(command, { ...process.env, ...env });
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  });
  after = await readRecord();
  assert.equal(after.version, newBuild);
  assert.notEqual(after.pid, before.pid);
  assert.notEqual(after.serviceId, before.serviceId);
  await writeFile(gate, "installed");
  await until("production restart notice", () =>
    frame().includes("Restart to update"),
  );
  terminal.write(" plus newer typing");
  const draft = "Unsubmitted before update plus newer typing";
  await until("latest draft", () => frame().includes(draft));
  await capture("installed-before-action");
  const rows = frame().split("\n");
  const y = rows.findIndex((row) => row.includes("Restart to update"));
  const x = rows[y].indexOf("Restart to update");
  terminal.write(`\x1b[<0;${x + 2};${y + 1}M\x1b[<0;${x + 2};${y + 1}m`);
  let liveReplacementFrame;
  await until("replacement TUI live with hydrated latest draft", async () => {
    const lines = (await readFile(trace, "utf8")).trim().split("\n");
    const invocations = lines.map((line) => JSON.parse(line));
    const rendered = frame();
    const ready = hasLiveReplacementDraft({
      invocations,
      frame: rendered,
      draft,
      sessionId: connected.sessionId,
      buildId: newBuild,
    });
    if (ready) liveReplacementFrame = rendered;
    return ready;
  });
  assert.ok(liveReplacementFrame);
  await capture("reconnected-draft", liveReplacementFrame);
  process.env.FUNGI_BUNDLED_BUILD_ID = newBuild;
  const resumed = await createPrivateLocalServiceManager({
    directory: join(home, ".fungi/service"),
  }).connect({ invocationRoot: project, sessionId: connected.sessionId });
  try {
    assert.equal(resumed.agentId, connected.agentId);
    assert.equal(resumed.sessionId, connected.sessionId);
    assert.notEqual(resumed.session.address, originalAddress);
    assert.equal((await readRecord()).pid, after.pid);
    const latest = await resumed.session.read();
    assert.equal(
      latest.messages.length,
      0,
      "draft must never have been submitted",
    );
  } finally {
    await resumed.close();
  }
  await writeFile(
    join(work, "receipt.json"),
    JSON.stringify(
      {
        work,
        before,
        after,
        agentId: connected.agentId,
        sessionId: connected.sessionId,
        originalAddress,
        resumedDraft: draft,
        replacementTuiFooter: liveReplacementFrame.split("\n").at(-1).trim(),
        calls,
        receipts,
      },
      null,
      2,
    ),
  );
  console.log(`Installed update/restart/draft continuity PASS: ${work}`);
} finally {
  try {
    await terminal?.close();
    await connected?.close();
    const current = await readRecord().catch((cause) => {
      if (cause instanceof Error && cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (current !== undefined) {
      const records = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(
        records.some(
          (entry) =>
            entry.pid === current.pid &&
            entry.args.includes("--internal-service"),
        ),
        "refuse cleanup of a PID not recorded by this proof",
      );
      await invoke([node, launcher, "stop"]);
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in savedEnvironment)) Reflect.deleteProperty(process.env, key);
    Object.assign(process.env, savedEnvironment);
  }
}
