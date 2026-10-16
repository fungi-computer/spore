import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { inspectGlibc } from "./inspect-glibc.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "acp-fixture": { type: "string" } },
});
const [tarball, ...nativeTarballs] = positionals;
if (tarball === undefined) throw new Error("Pass a local CLI tarball");
const archive = resolve(tarball);
const root = await mkdtemp(join(tmpdir(), "fungi-cli-proof-"));
const install = join(root, "install");
const installedCli = join(
  install,
  "node_modules/@fungi.computer/spore/dist/cli.js",
);
const environment = {
  ...process.env,
  FUNGI_BUNDLED_CLI: installedCli,
  HOME: join(root, "home"),
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
};
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${String(result.status)})`);
}
try {
  run("npm", [
    "install",
    "--prefix",
    install,
    "--cache",
    join(root, "cache"),
    "--no-audit",
    "--no-fund",
    archive,
    ...nativeTarballs.map((path) => resolve(path)),
  ]);
  await access(
    join(
      install,
      "node_modules/@fungi.computer/spore/dist/internal/computerd.cjs",
    ),
  );
  const fungi = join(install, "node_modules/.bin/fungi");
  const packageRoot = join(install, "node_modules/@fungi.computer/spore");
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@fungi.computer/spore");
  assert.equal(manifest.version, "0.0.1");
  assert.equal(manifest.bin.fungi, "dist/fungi.cjs");
  assert.equal(manifest.os, undefined);
  assert.equal(manifest.cpu, undefined);
  const nativeBinary = createRequire(join(packageRoot, "package.json")).resolve(
    `@fungi.computer/spore-native-${process.platform}-${process.arch}/bin/fungi-apply-patch`,
  );
  const nativeRoot = dirname(dirname(nativeBinary));
  const nativeManifest = JSON.parse(
    await readFile(join(nativeRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(nativeManifest.os, [process.platform]);
  assert.deepEqual(nativeManifest.cpu, [process.arch]);
  if (process.platform === "linux")
    assert.deepEqual(nativeManifest.libc, ["glibc"]);
  assert.match(
    await readFile(join(packageRoot, "README.md"), "utf8"),
    /fungi acp/,
  );
  assert.match(
    await readFile(join(packageRoot, "THIRD_PARTY_NOTICES"), "utf8"),
    /THIRD-PARTY NOTICES/,
  );
  assert.match(
    await readFile(join(nativeRoot, "THIRD_PARTY_NOTICES"), "utf8"),
    /codex-apply-patch/,
  );
  assert.match(
    await readFile(
      join(packageRoot, "native/apply-patch/LICENSE.codex"),
      "utf8",
    ),
    /Apache License/,
  );
  run(fungi, ["--version"]);
  run(fungi, ["acp", "--help"]);
  run(fungi, ["--help"]);
  run(fungi, ["login", "--help"]);
  run(fungi, ["sessions", "--help"]);
  const project = join(root, "project");
  await mkdir(project);
  const patch = spawnSync(nativeBinary, [], {
    cwd: project,
    env: environment,
    encoding: "utf8",
    input:
      "*** Begin Patch\n*** Add File: native-proof.txt\n+PACKED_PATCH_OK\n*** End Patch\n",
  });
  assert.equal(patch.status, 0, patch.stderr);
  assert.equal(
    await readFile(join(project, "native-proof.txt"), "utf8"),
    "PACKED_PATCH_OK\n",
  );
  try {
    run(fungi, ["sessions", "list", "-C", project]);
    const record = JSON.parse(
      await readFile(
        join(environment.HOME, ".fungi/service/service.json"),
        "utf8",
      ),
    );
    const response = await fetch(
      `${record.baseUrl}/service/${record.serviceId}/status`,
    );
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(
      status.buildId,
      createHash("sha256")
        .update(await readFile(installedCli))
        .digest("hex"),
      "Packed launcher and Local service must publish the same bundle ID",
    );
  } finally {
    run(fungi, ["stop"]);
  }
  const fixture = join(root, "packed-cli.proof.mjs");
  await copyFile(
    fileURLToPath(new URL("../test/packed-cli.proof.mjs", import.meta.url)),
    fixture,
  );
  const platform = `${process.platform}-${process.arch}`;
  const bunPackages = {
    "linux-x64": "@oven/bun-linux-x64",
    "linux-arm64": "@oven/bun-linux-aarch64",
    "darwin-arm64": "@oven/bun-darwin-aarch64",
    "darwin-x64": "@oven/bun-darwin-x64",
  };
  const bunPackage = bunPackages[platform];
  if (bunPackage === undefined)
    throw new Error(`Unsupported platform: ${platform}`);
  run(join(install, "node_modules", bunPackage, "bin/bun"), [
    fixture,
    installedCli,
  ]);
  let acpFixture = fileURLToPath(
    new URL("../test/acp-stdio.proof.mjs", import.meta.url),
  );
  if (values["acp-fixture"]) {
    // A portable proof kit bundles the workspace fixture's JS dependencies.
    // Resolve its external runtimes and worker assets from the installed CLI.
    acpFixture = join(dirname(installedCli), "acp-stdio.proof.mjs");
    await copyFile(resolve(values["acp-fixture"]), acpFixture);
  }
  run(join(install, "node_modules", bunPackage, "bin/bun"), [
    acpFixture,
    installedCli,
  ]);
  if (process.platform === "linux") await inspectGlibc(install);
  const hiddenNative = join(root, "missing-native-package");
  await rename(nativeRoot, hiddenNative);
  try {
    const missing = spawnSync(fungi, ["--version"], {
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(missing.status, 0);
    assert.match(
      missing.stderr,
      /Fungi CLI could not load its native dependencies/,
    );
  } finally {
    await rename(hiddenNative, nativeRoot);
  }
  console.log(`Packed CLI proof passed on ${platform}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
