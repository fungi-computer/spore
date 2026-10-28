// Rehearsal only: the installed 0.2.1 service upgrades into a ready Session
// in a new project; its old project refuses clearly without moving the store.
// This is neither go_preflight nor proof of same-project recovery.
// Run after build:proof-package, under run-proof.sh and the heavy slot.
import assert from "node:assert/strict";
import console from "node:console";
import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { Terminal as Emulator } from "@xterm/headless";
import { sleep, spawn, Terminal } from "bun";
import { z } from "zod";
import { packProofPackage } from "../../../tooling/repository/scripts/proof-tarball.mjs";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const proofArea = join(repository, ".botanical", "upgrade-proof");
const root = await (async () => {
  await mkdir(proofArea, { recursive: true, mode: 0o700 });
  return mkdtemp(join(proofArea, "rehearsal-"));
})();
const home = join(root, "home");
const prefix = join(root, "prefix");
const project = join(root, "old-project");
const freshProject = join(root, "fresh-project");
const fixture = join(root, "fixture-extension");
const launcher = join(prefix, "bin", "fungi");
const installed = join(
  prefix,
  "lib",
  "node_modules",
  "@fungi.computer",
  "spore",
);
const oldIntegrity =
  "sha512-S6B5UdEdHPnwML/rCgGyEqo+itYiARwiLQG/aFT83ddcxc5yQgPn/wK+ZrGd5lg/uEkFe/PRCgJVXI/rUtji5g==";
const env = {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"),
  NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
  PATH: `${join(prefix, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  TMPDIR: root,
};
await Promise.all(
  [home, project, freshProject, fixture, env.XDG_RUNTIME_DIR].map((path) =>
    mkdir(path, { recursive: true, mode: 0o700 }),
  ),
);
await writeFile(
  join(fixture, "package.json"),
  `${JSON.stringify({
    name: "fungi-upgrade-proof-extension",
    version: "1.0.0",
    type: "module",
    fungi: { id: "upgrade-proof-extension" },
  })}\n`,
);

function run(command, args, cwd = root, timeoutMs = 90_000) {
  return new Promise((accept, reject) => {
    const child = nodeSpawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} exceeded ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      accept({ code, signal, stdout, stderr });
    });
  });
}
async function success(command, args, cwd, timeoutMs) {
  const result = await run(command, args, cwd, timeoutMs);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result;
}
async function record() {
  return z
    .looseObject({ protocol: z.number(), pid: z.number().int() })
    .parse(
      JSON.parse(
        await readFile(join(home, ".fungi", "service", "service.json"), "utf8"),
      ),
    );
}
async function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause.code === "ESRCH") return false;
    throw cause;
  }
}
async function frame(cwd, expected, timeoutMs = 25_000) {
  const screen = new Emulator({ cols: 120, rows: 36, allowProposedApi: true });
  const terminal = new Terminal({
    cols: 120,
    rows: 36,
    data(_terminal, bytes) {
      screen.write(bytes);
    },
  });
  const child = spawn([launcher, "new"], {
    cwd,
    env: { ...env, COLUMNS: "120", LINES: "36" },
    terminal,
  });
  const text = () =>
    Array.from(
      { length: 36 },
      (_, row) =>
        screen.buffer.active.getLine(row)?.translateToString(true) ?? "",
    )
      .join("\n")
      .replace(/\s+/gu, " ");
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (expected(text())) return text();
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    throw new Error(`Expected ready Session frame, got:\n${text()}`);
  } finally {
    terminal.write("\x03");
    await Promise.race([child.exited, sleep(1_500)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    terminal.close();
    screen.dispose();
  }
}
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

let oldPid;
let receipt;
let proofFailure;
try {
  // The old install is from npm, not a repacked fixture or the source tree.
  const registry = await success("npm", [
    "view",
    "@fungi.computer/spore@0.2.1",
    "dist.integrity",
    "--json",
    "--cache",
    join(root, "cache"),
  ]);
  assert.equal(
    z.string().startsWith("sha512-").parse(JSON.parse(registry.stdout)),
    oldIntegrity,
  );
  await success(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      prefix,
      "--cache",
      join(root, "cache"),
      "--no-audit",
      "--no-fund",
      "@fungi.computer/spore@0.2.1",
    ],
    root,
    180_000,
  );
  assert.match((await success(launcher, ["--version"])).stdout, /0\.2\.1/u);
  const oldRun = await run(launcher, ["run", "hi"], project);
  assert.equal(oldRun.code, 1);
  assert.match(oldRun.stderr, /No signed-in model provider/u);
  const oldService = await record();
  assert.equal(oldService.protocol, 3);
  oldPid = oldService.pid;
  assert.equal(await alive(oldPid), true);
  const oldAgents = join(project, ".fungi", "agents");
  const oldStore = (await readdir(oldAgents)).find((entry) =>
    entry.startsWith("local_store_"),
  );
  assert.ok(oldStore, "0.2.1 must produce its real project-local Agent store");
  const oldDatabase = join(oldAgents, oldStore, "agent.sqlite");
  assert.equal((await stat(oldDatabase)).isFile(), true);
  await success(launcher, ["extension", "add", fixture], project);
  const registryPath = join(home, ".fungi", "extensions", "installed.json");
  const installedExtension = await readFile(registryPath, "utf8");
  assert.match(installedExtension, /upgrade-proof-extension/u);

  const [spore, native] =
    process.argv.length === 4
      ? process.argv.slice(2).map((path) => resolve(path))
      : await (async () => {
          if (process.argv.length !== 2)
            throw new Error("Pass both candidate tarballs, or neither");
          const local = [];
          for (const path of [
            join(repository, ".botanical", "fungi-cli-package"),
            join(
              repository,
              `.botanical/fungi-cli-native-${process.platform}-${process.arch}`,
            ),
          ]) {
            const result = await packProofPackage(path);
            local.push(result.tarball);
          }
          return local;
        })();
  const hashes = [await digest(spore), await digest(native)];
  await success(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      prefix,
      "--cache",
      join(root, "cache"),
      "--no-audit",
      "--no-fund",
      spore,
      native,
    ],
    root,
    180_000,
  );
  const packageVersion = z
    .looseObject({
      version: z.string().min(1),
      optionalDependencies: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(await readFile(join(installed, "package.json"), "utf8")));
  const candidateVersion = packageVersion.version;
  const upgraded = await success(launcher, ["sessions", "list"], freshProject);
  assert.match(upgraded.stderr, /Upgraded an earlier Fungi \(protocol 3\)/u);
  assert.match(upgraded.stdout, /No saved conversations/u);
  const news = z
    .strictObject({ release: z.string(), lines: z.array(z.string()) })
    .parse(
      JSON.parse(
        await readFile(join(installed, "dist", "whats-new.json"), "utf8"),
      ),
    );
  for (const line of news.lines) assert.ok(upgraded.stderr.includes(line));
  assert.equal(await alive(oldPid), false, "old service survived the upgrade");
  assert.equal((await record()).protocol, 4);
  assert.deepEqual(
    JSON.parse(await readFile(join(home, ".fungi", "version.json"), "utf8")),
    {
      version: 1,
      release: news.release,
      spore: z
        .looseObject({ version: z.string() })
        .parse(
          JSON.parse(await readFile(join(installed, "package.json"), "utf8")),
        ).version,
      build: await digest(join(installed, "dist", "cli.js")),
    },
  );
  assert.equal(await readFile(registryPath, "utf8"), installedExtension);
  const again = await success(launcher, ["sessions", "list"], freshProject);
  assert.equal(again.stderr, "", "the upgrade notice must appear only once");
  const oldDatabaseDigest = await digest(oldDatabase);
  const oldAgentEntries = await readdir(oldAgents);
  const sameProject = await run(launcher, ["run", "hi"], project);
  assert.equal(sameProject.code, 1, "old project must refuse this store");
  const refusal = sameProject.stderr
    .split(/\r?\n/u)
    .filter((line) => line.includes(`Agent store ${oldDatabase}`));
  assert.equal(
    refusal.length,
    1,
    `Expected one path-specific refusal, got:\n${sameProject.stderr}`,
  );
  assert.match(
    refusal[0],
    /is incompatible with this version of Fungi/u,
    "old project must explain the refusal in plain language",
  );
  assert.doesNotMatch(sameProject.stderr, /LocalStoreSchemaError/u);
  assert.equal(
    await digest(oldDatabase),
    oldDatabaseDigest,
    "old project Agent store changed without an archive decision",
  );
  assert.deepEqual(
    await readdir(oldAgents),
    oldAgentEntries,
    "old project gained an Agent without an archive decision",
  );
  await assert.rejects(stat(join(project, ".fungi", "archive")), {
    code: "ENOENT",
  });
  const fresh = await frame(
    freshProject,
    (text) => text.includes("Ask anything") && text.includes("idle"),
  );
  assert.match(fresh, /Ask anything/u);
  const nativePackage = `@fungi.computer/spore-native-${process.platform}-${process.arch}`;
  assert.equal(
    packageVersion.optionalDependencies[nativePackage],
    candidateVersion,
  );
  const nativeVersion = z
    .looseObject({ version: z.string() })
    .parse(
      JSON.parse(
        await readFile(
          join(prefix, "lib", "node_modules", nativePackage, "package.json"),
          "utf8",
        ),
      ),
    ).version;
  assert.equal(nativeVersion, candidateVersion);
  assert.equal(
    (await success(launcher, ["--version"])).stdout.trim(),
    `Spore ${candidateVersion}`,
  );
  const sha = (
    await success("git", ["rev-parse", "HEAD"], repository)
  ).stdout.trim();
  receipt = {
    kind: "REHEARSAL_ONLY_NOT_GO_PREFLIGHT",
    candidate: sha,
    sporeSha256: hashes[0],
    nativeSha256: hashes[1],
    published021Integrity: oldIntegrity,
    sporeVersion: candidateVersion,
    nativeVersion,
    localVersionManifestSha256: await digest(
      join(repository, "apps", "tui", "package.json"),
    ),
    releaseLabel: news.release,
    observed: [
      "published 0.2.1 produced live protocol-3 service and a project-local Agent store",
      "the old service stopped before candidate sessions listed",
      "0.2.1 extension registry remained readable and untouched",
      "second command had no upgrade notice; a new-project Session opened to a ready idle first frame",
      `the old project refused ${oldDatabase} in one plain line and left its bytes untouched`,
    ],
    notProved: [
      "the old project's store remains incompatible; no same-project recovery or project archive",
      "no model credential or completed model turn",
      "no production candidate, candidate-bound go_preflight gate or publication",
    ],
  };
} catch (cause) {
  proofFailure = cause;
} finally {
  if (oldPid !== undefined) {
    let stopFailure;
    try {
      const stopped = await run(launcher, ["stop"]);
      if (stopped.code !== 0)
        stopFailure = new Error(
          `Could not stop proof service: ${stopped.stderr}`,
        );
    } catch (cause) {
      stopFailure = cause;
    }
    if (stopFailure !== undefined)
      proofFailure =
        proofFailure === undefined
          ? stopFailure
          : new AggregateError(
              [proofFailure, stopFailure],
              "Upgrade proof and service cleanup both failed",
            );
  }
  if (oldPid && (await alive(oldPid))) process.kill(oldPid, "SIGTERM");
  // Generated proof homes and packs stay inside ignored .botanical for review.
  console.log(`Proof home (isolated): ${root}`);
}
if (proofFailure !== undefined) throw proofFailure;
if (receipt === undefined) throw new Error("Upgrade proof has no receipt");
await writeFile(
  join(root, "upgrade-proof.rehearsal.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(`REHEARSAL_ONLY ${root} ${receipt.candidate}`);
