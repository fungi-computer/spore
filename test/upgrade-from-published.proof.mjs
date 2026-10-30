// Run the published updater itself, against unpublished local npm tarballs.
// Each baseline gets its own HOME, global prefix, project and npm cache.
import assert from "node:assert/strict";
import console from "node:console";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import semver from "semver";
import { z } from "zod";
import {
  expectReportedVersion,
  reportedVersion,
} from "@fungi.computer/cli-version";
import { packProofPackage } from "../../../tooling/repository/scripts/proof-tarball.mjs";
import { startUpgradeRegistry } from "./upgrade-registry.fixture.mjs";

const { fetch, AbortSignal } = globalThis;
const baseline = z.enum(["0.5.0", "0.4.0"]).parse(process.env.UPGRADE_FROM);
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const area = join(repository, ".botanical", "upgrade-proof");
await mkdir(area, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(area, `from-${baseline}-`));
const home = join(root, "home");
const prefix = join(root, "prefix");
const project = join(root, "project");
const launcher = join(prefix, "bin", "fungi");
const installed = join(
  prefix,
  "lib",
  "node_modules",
  "@fungi.computer",
  "spore",
);
const env = {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_CACHE_HOME: join(home, "cache"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  NPM_CONFIG_PREFIX: prefix,
  NPM_CONFIG_CACHE: join(root, "npm-cache"),
  NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"),
  NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
  PATH: `${join(prefix, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  TERM: "dumb",
  NO_COLOR: "1",
  LANG: "C.UTF-8",
  TMPDIR: root,
};
await Promise.all(
  [home, project, env.XDG_RUNTIME_DIR, join(prefix, "bin")].map((path) =>
    mkdir(path, { recursive: true, mode: 0o700 }),
  ),
);
// The published updater prepends its Node executable's directory to PATH.
// Put Node in the proof prefix too: otherwise the machine's real global fungi
// beside Node can shadow this isolated install during the restart identity
// check. A symlink would resolve process.execPath back to the machine prefix.
await copyFile(process.execPath, join(prefix, "bin", "node"));
await chmod(join(prefix, "bin", "node"), 0o700);
await writeFile(env.NPM_CONFIG_USERCONFIG, "", { mode: 0o600 });
await writeFile(env.NPM_CONFIG_GLOBALCONFIG, "", { mode: 0o600 });

let registry;
const commands = [];
function run(command, args, timeoutMs = 90_000) {
  commands.push([command, ...args]);
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: project,
      env: { ...env, ...registry?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
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
async function success(command, args, timeoutMs) {
  const result = await run(command, args, timeoutMs);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`,
  );
  return result;
}
const serviceSchema = z.looseObject({
  pid: z.number().int().positive(),
  protocol: z.number().int().positive(),
  version: z.string().min(1),
  serviceId: z.string().min(1),
  baseUrl: z.url(),
});
const sessionSchema = z.looseObject({
  sessionId: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
});
async function service() {
  return serviceSchema.parse(
    JSON.parse(
      await readFile(join(home, ".fungi", "service", "service.json"), "utf8"),
    ),
  );
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause.code === "ESRCH") return false;
    throw cause;
  }
}
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
let receipt;
let failure;
let serviceStarted = false;
try {
  const integrity = z
    .string()
    .startsWith("sha512-")
    .parse(
      JSON.parse(
        (
          await success("npm", [
            "view",
            `@fungi.computer/spore@${baseline}`,
            "dist.integrity",
            "--json",
          ])
        ).stdout,
      ),
    );
  await success(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      `@fungi.computer/spore@${baseline}`,
    ],
    180_000,
  );
  assert.equal(
    reportedVersion((await success(launcher, ["--version"])).stdout)?.version,
    baseline,
  );
  // A real published CLI creates the Session. No fixture database or current
  // harness constructs old data; no live model credential is copied.
  serviceStarted = true;
  const prompt = `Upgrade Session from ${baseline}`;
  const created = await run(launcher, ["run", prompt]);
  assert.equal(created.code, 1, created.stderr);
  assert.match(created.stderr, /No signed-in model provider/u);
  const before = sessionSchema.parse(
    JSON.parse(
      (await success(launcher, ["sessions", "show", "--last", "--json"]))
        .stdout,
    ),
  );
  assert.ok(
    JSON.stringify(before.messages).includes(prompt),
    "The published CLI must save the pre-update prompt",
  );
  const oldService = await service();
  assert.equal(alive(oldService.pid), true);
  console.log(
    `BASELINE_READY ${baseline} Session=${before.sessionId} service=${oldService.version}`,
  );

  const tarballs = process.argv.slice(2);
  if (tarballs.length !== 0 && tarballs.length !== 2)
    throw new Error(
      "Pass both candidate Spore and native tarballs, or neither",
    );
  const paths =
    tarballs.length === 2
      ? tarballs.map((path) => resolve(path))
      : await Promise.all(
          [
            join(repository, ".botanical", "fungi-cli-package"),
            join(
              repository,
              `.botanical/fungi-cli-native-${process.platform}-${process.arch}`,
            ),
          ].map(async (path) => (await packProofPackage(path)).tarball),
        );
  registry = await startUpgradeRegistry(root, paths);
  const candidate = registry.packages.find(
    ({ manifest }) => manifest.name === "@fungi.computer/spore",
  );
  assert.ok(candidate, "Candidate pack must contain Spore");
  assert.equal(
    semver.gt(candidate.manifest.version, baseline),
    true,
    "Stage a distinct unpublished candidate version; equal versions exercise only a no-op",
  );

  // Critical: do not replace this with npm install + manual service restart.
  // The unchanged, published baseline updater must perform the whole operation.
  const updated = await success(launcher, ["update"], 180_000);
  console.log(updated.stdout, updated.stderr);
  assert.ok(
    expectReportedVersion(
      (await success(launcher, ["--version"])).stdout,
      candidate.manifest.version,
    ),
  );
  const newService = await service();
  assert.equal(newService.protocol, 5);
  assert.notEqual(
    newService.pid,
    oldService.pid,
    "The published service owner was not replaced",
  );
  assert.equal(alive(oldService.pid), false, "The old service is still alive");
  assert.equal(alive(newService.pid), true);
  const candidateBuild = await digest(join(installed, "dist", "cli.js"));
  assert.equal(
    newService.version,
    candidateBuild,
    "The running service must have the installed candidate's actual build identity",
  );
  const status = await fetch(
    `${newService.baseUrl}/service/${newService.serviceId}/status`,
    { signal: AbortSignal.timeout(3_000) },
  );
  assert.equal(status.status, 200);
  assert.equal(
    serviceSchema.parse(await status.json()).version,
    candidateBuild,
  );

  // Read by the OLD id in the SAME project, not --last in a fresh folder.
  const after = sessionSchema.parse(
    JSON.parse(
      (
        await success(launcher, [
          "sessions",
          "show",
          before.sessionId,
          "--json",
        ])
      ).stdout,
    ),
  );
  assert.equal(after.sessionId, before.sessionId);
  assert.deepEqual(after.messages, before.messages);
  assert.ok(
    registry.requests.includes("/@fungi.computer/spore/latest"),
    "The published updater did not consult the candidate registry",
  );
  assert.ok(
    registry.requests.includes("/tarballs/0.tgz"),
    "The package manager did not install the local candidate archive",
  );
  receipt = {
    kind: `PUBLISHED_${baseline}_REAL_UPDATE_SESSION_SURVIVES`,
    baseline,
    publishedIntegrity: integrity,
    candidateVersion: candidate.manifest.version,
    candidateBuild,
    sessionId: before.sessionId,
    retainedMessages: before.messages.length,
    oldService,
    newService,
    tarballs: registry.packages.map(({ path, manifest, integrity }) => ({
      path,
      name: manifest.name,
      version: manifest.version,
      integrity,
    })),
    commands,
    registryRequests: registry.requests,
    notProved: [
      "No completed model turn or model credential",
      "No publication or production migration",
    ],
  };
} catch (cause) {
  console.error(
    "Upgrade rehearsal failed; cleaning up its isolated service",
    cause,
  );
  failure = cause;
} finally {
  if (serviceStarted) {
    try {
      await success(launcher, ["stop"]);
    } catch (cause) {
      console.error("Could not stop the isolated upgrade service", cause);
      failure =
        failure === undefined
          ? cause
          : new AggregateError(
              [failure, cause],
              "Upgrade and cleanup both failed",
            );
    }
  }
  await registry?.close();
  console.log(`Proof home (isolated): ${root}`);
}
if (failure !== undefined) throw failure;
assert.ok(receipt, "No upgrade receipt was produced");
await writeFile(
  join(root, "upgrade-proof.rehearsal.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(
  `PASS ${receipt.kind}: candidate service starts; Session ${receipt.sessionId} survives`,
);
