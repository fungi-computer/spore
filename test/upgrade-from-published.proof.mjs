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
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { setTimeout, clearTimeout } from "node:timers";
import semver from "semver";
import { z } from "zod";
import {
  expectReportedVersion,
  reportedVersion,
} from "@fungi.computer/cli-version";
import { releasePackages } from "../../../tooling/release/data-impact.mjs";
import { readPack } from "../../../tooling/release/pack-inputs.mjs";
import {
  declaredLocalSessionResets,
  upgradeReportSchema,
} from "./upgrade-report.mjs";
import { startUpgradeRegistry } from "./upgrade-registry.fixture.mjs";

const { fetch, AbortSignal } = globalThis;
const { values } = parseArgs({
  options: {
    from: { type: "string", multiple: true },
    candidate: { type: "string" },
    report: { type: "string" },
  },
});
const baselines = z
  .array(
    z.string().refine((version) => semver.valid(version) === version, {
      message: "--from must name a canonical semantic version",
    }),
  )
  .min(1, "--from is required (repeat it for each published baseline)")
  .parse(values.from ?? []);
if (!values.candidate) throw new Error("--candidate is required");
if (!values.report) throw new Error("--report is required");
const candidateDir = resolve(values.candidate);
const candidatePack = await readPack(candidateDir);
const paths = [
  "@fungi.computer/spore",
  `@fungi.computer/spore-native-${process.platform}-${process.arch}`,
].map((name) => {
  const item = candidatePack.packages.find((item) => item.name === name);
  assert.ok(item, `Candidate pack is missing ${name}`);
  return join(candidateDir, item.file);
});
const report = { from: [], checks: [] };
const survivalCheck = "Local Session survives published update";
const resetCheck = "declared Local Session reset refuses and recovers";

for (const fungi of baselines) {
  let published;
  try {
    published = releasePackages(fungi);
    report.from.push(published);
  } catch (cause) {
    console.error(`Cannot resolve published Fungi ${fungi}`, cause);
    report.checks.push({
      name: "published Fungi release resolution",
      from: fungi,
      status: "fail",
    });
    continue;
  }
  const baseline = published.spore;
  // The caller owns the checkout. A driver imported from another worktree
  // must not place generated state beside its source or share another dist.
  const area = resolve(".botanical", "upgrade-proof");
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
    const integrity = published.integrity.spore;
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
    const candidateBuild = await digest(join(installed, "dist", "cli.js"));
    // Service identity is the bundle, not the package version. Right after a
    // release the newest baseline can already run a byte-identical service
    // build; the updater's restart then correctly keeps that owner.
    const serviceReplaced = oldService.version !== candidateBuild;
    if (serviceReplaced) {
      assert.notEqual(
        newService.pid,
        oldService.pid,
        "The published service owner was not replaced",
      );
      assert.equal(
        alive(oldService.pid),
        false,
        "The old service is still alive",
      );
    } else
      assert.equal(
        newService.pid,
        oldService.pid,
        "An identical service build must keep its owner",
      );
    assert.equal(alive(newService.pid), true);
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

    // The candidate's reviewed claims decide whether this upgrade crosses a
    // Local Session reset; without one the old Session must survive unchanged.
    const declared = declaredLocalSessionResets(process.cwd(), fungi);
    let outcome;
    if (declared.length === 0) {
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
      outcome = {
        kind: `PUBLISHED_${baseline}_REAL_UPDATE_SESSION_SURVIVES`,
        retainedMessages: before.messages.length,
      };
    } else {
      // The one Agent store the published CLI created in this project.
      const agents = join(project, ".fungi", "agents");
      const owners = [];
      for (const name of await readdir(agents))
        if ((await readdir(join(agents, name))).includes("agent.sqlite"))
          owners.push(join(agents, name));
      assert.equal(owners.length, 1, "Expected one published Agent store");
      const [store] = owners;
      const storeFiles = async () =>
        Object.fromEntries(
          await Promise.all(
            (await readdir(store))
              .filter((name) => name.startsWith("agent.sqlite"))
              .sort()
              .map(async (name) => [name, await digest(join(store, name))]),
          ),
        );
      const retained = await storeFiles();
      const refused = await run(launcher, [
        "sessions",
        "show",
        before.sessionId,
        "--json",
      ]);
      assert.notEqual(
        refused.code,
        0,
        "A declared reset must refuse the old Session",
      );
      assert.ok(
        refused.stderr.includes(
          `Agent store ${join(store, "agent.sqlite")} is incompatible with this version of Fungi. To reset, stop the owning Fungi service, then move this database, its .owner.sqlite sidecar and any associated SQLite journal files aside together. Create a fresh Agent; existing Sessions are not migrated.`,
        ),
        `The refusal must name the store and its documented recovery:\n${refused.stderr}`,
      );
      assert.deepEqual(
        await storeFiles(),
        retained,
        "Refusal rewrote the old store",
      );
      // The documented recovery, exactly: stop, move the files aside together,
      // then a fresh Agent in the same project works on the candidate service.
      await success(launcher, ["stop"]);
      const moved = join(root, "moved-agent-store");
      await mkdir(moved, { mode: 0o700 });
      for (const name of Object.keys(retained))
        await rename(join(store, name), join(moved, name));
      const prompt = `Fresh Agent after ${baseline} reset`;
      const fresh = await run(launcher, ["run", prompt]);
      assert.equal(fresh.code, 1, fresh.stderr);
      assert.match(fresh.stderr, /No signed-in model provider/u);
      const recovered = sessionSchema.parse(
        JSON.parse(
          (await success(launcher, ["sessions", "show", "--last", "--json"]))
            .stdout,
        ),
      );
      assert.notEqual(recovered.sessionId, before.sessionId);
      assert.ok(JSON.stringify(recovered.messages).includes(prompt));
      assert.equal((await service()).version, candidateBuild);
      const kept = Object.fromEntries(
        await Promise.all(
          Object.keys(retained).map(async (name) => [
            name,
            await digest(join(moved, name)),
          ]),
        ),
      );
      assert.deepEqual(kept, retained, "The moved store must keep its bytes");
      outcome = {
        kind: `PUBLISHED_${baseline}_REAL_UPDATE_SESSION_RESET_RECOVERED`,
        resetClaims: declared.map(({ version, id }) => `${version}:${id}`),
        movedFiles: Object.entries(retained).map(([name, sha256]) => ({
          name,
          sha256,
        })),
        recoveredSessionId: recovered.sessionId,
      };
    }
    assert.ok(
      registry.requests.includes("/@fungi.computer/spore/latest"),
      "The published updater did not consult the candidate registry",
    );
    assert.ok(
      registry.requests.includes("/tarballs/0.tgz"),
      "The package manager did not install the local candidate archive",
    );
    receipt = {
      ...outcome,
      baseline,
      publishedIntegrity: integrity,
      release: published,
      candidateVersion: candidate.manifest.version,
      candidateBuild,
      serviceReplaced,
      sessionId: before.sessionId,
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
  if (failure !== undefined) {
    console.error(`Fungi ${fungi} upgrade failed`, failure);
    report.checks.push({
      name: declaredLocalSessionResets(process.cwd(), fungi).length
        ? resetCheck
        : survivalCheck,
      from: fungi,
      status: "fail",
    });
    continue;
  }
  assert.ok(receipt, "No upgrade receipt was produced");
  await writeFile(
    join(root, "upgrade-proof.rehearsal.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    `PASS ${receipt.kind}: candidate service starts; Session ${receipt.sessionId} ${receipt.resetClaims ? `refused and recovered under ${receipt.resetClaims.join(", ")}` : "survives"}`,
  );
  report.checks.push({
    name: receipt.resetClaims ? resetCheck : survivalCheck,
    from: fungi,
    status: "pass",
  });
}
const decoded = upgradeReportSchema.parse(report);
const rechecked = await readPack(candidateDir);
assert.deepEqual(
  rechecked.order,
  candidatePack.order,
  "Candidate order changed",
);
assert.deepEqual(
  rechecked.checksums,
  candidatePack.checksums,
  "Candidate checksums changed",
);
await writeFile(
  resolve(values.report),
  `${JSON.stringify(decoded, null, 2)}\n`,
  {
    mode: 0o600,
    flag: "wx",
  },
);
if (decoded.checks.some(({ status }) => status !== "pass"))
  process.exitCode = 1;
