import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const platform = `${process.platform}-${process.arch}`;
const bunPackage =
  process.arch === "arm64"
    ? `@oven/bun-${process.platform}-aarch64`
    : `@oven/bun-${process.platform}-x64`;
const bun = resolve(root, "node_modules/bun/bin/bun.exe");
const fixture = mkdtempSync(join(tmpdir(), "fungi-host-autoload-"));

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: join(fixture, "home"), ...env },
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

try {
  const project = join(fixture, "project");
  const install = join(fixture, "install");
  const archive = join(fixture, "compiled");
  const buildRoot = join(fixture, "build");
  const marker = join(project, "preloaded");
  const contaminated = join(project, "from-dotenv");
  for (const dir of [project, install, archive, join(fixture, "home")])
    mkdirSync(dir, { recursive: true });
  copyFileSync(resolve(root, "package.json"), join(install, "package.json"));
  writeFileSync(
    join(project, "evil.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "AGENT PRELOAD RAN IN HOST");\n`,
  );
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./evil.js"]\n');
  writeFileSync(
    join(project, ".env"),
    `FUNGI_INSTALL=${contaminated}\nFUNGI_NODE=${join(project, "fake-node")}\n`,
  );

  const cli =
    'console.log("HOST_ENTRY_RAN:" + (process.env.FUNGI_INSTALL ?? "clean") + ":" + (process.env.FUNGI_NODE ?? "clean"));\n';
  const installedDist = join(install, "dist");
  mkdirSync(installedDist);
  writeFileSync(join(installedDist, "cli.js"), cli);
  copyFileSync(resolve(root, "package.json"), join(install, "package.json"));
  copyFileSync(
    resolve(root, "scripts/fungi.cjs"),
    join(installedDist, "fungi.cjs"),
  );
  const native = join(
    install,
    "node_modules",
    `@fungi.computer/spore-native-${platform}`,
  );
  mkdirSync(join(native, "bin"), { recursive: true });
  writeFileSync(
    join(native, "package.json"),
    JSON.stringify({
      name: `@fungi.computer/spore-native-${platform}`,
      exports: { "./bin/fungi-apply-patch": "./bin/fungi-apply-patch" },
    }),
  );
  writeFileSync(join(native, "bin/fungi-apply-patch"), "fixture");
  const oven = join(install, "node_modules", bunPackage);
  mkdirSync(join(oven, "bin"), { recursive: true });
  writeFileSync(
    join(oven, "package.json"),
    JSON.stringify({
      name: bunPackage,
      exports: { "./bin/bun": "./bin/bun" },
    }),
  );
  symlinkSync(bun, join(oven, "bin/bun"));

  test("npm launcher ignores project bunfig preload and .env", () => {
    const result = run(
      process.execPath,
      [join(installedDist, "fungi.cjs")],
      project,
    );
    assert.throws(() => readFileSync(marker));
    assert.match(result, /HOST_ENTRY_RAN:clean:clean/u);
  });

  const nativePackage = join(
    archive,
    "node_modules",
    `@fungi.computer/spore-native-${platform}`,
  );
  const workerd = join(
    archive,
    "node_modules",
    `@cloudflare/workerd-${process.platform}-${process.arch === "x64" ? "64" : "arm64"}`,
  );
  const opentui = join(archive, "node_modules", `@opentui/core-${platform}`);
  const keyringTarget = `${platform}${process.platform === "linux" ? "-gnu" : ""}`;
  const keyring = join(
    archive,
    "node_modules",
    `@napi-rs/keyring-${keyringTarget}`,
  );
  mkdirSync(join(archive, "dist"), { recursive: true });
  mkdirSync(join(nativePackage, "bin"), { recursive: true });
  mkdirSync(join(workerd, "bin"), { recursive: true });
  mkdirSync(join(opentui), { recursive: true });
  mkdirSync(keyring, { recursive: true });
  mkdirSync(join(archive, "node_modules/miniflare"), { recursive: true });
  mkdirSync(join(archive, "node_modules", bunPackage, "bin"), {
    recursive: true,
  });
  writeFileSync(join(archive, "dist/cli.js"), cli);
  writeFileSync(
    join(archive, "package.json"),
    JSON.stringify({
      name: "@fungi.computer/spore",
      optionalDependencies: {
        [`@fungi.computer/spore-native-${platform}`]: "fixture",
      },
    }),
  );
  writeFileSync(join(archive, "computerd-loopback.cjs"), "fixture");
  writeFileSync(join(archive, "node_modules/miniflare/package.json"), "{}");
  writeFileSync(join(nativePackage, "bin/fungi-apply-patch"), "fixture");
  writeFileSync(join(workerd, "bin/workerd"), "fixture");
  // This launcher-only fixture never loads native assets, but staging must
  // include the keyring asset now required by the real binary builder.
  writeFileSync(join(keyring, `keyring.${keyringTarget}.node`), "fixture");
  chmodSync(join(nativePackage, "bin/fungi-apply-patch"), 0o755);
  chmodSync(join(workerd, "bin/workerd"), 0o755);
  writeFileSync(
    join(
      opentui,
      process.platform === "darwin" ? "libopentui.dylib" : "libopentui.so",
    ),
    "fixture",
  );
  writeFileSync(join(keyring, `keyring.${keyringTarget}.node`), "fixture");
  copyFileSync(bun, join(archive, "node_modules", bunPackage, "bin/bun"));
  const scripts = join(buildRoot, "apps/tui/scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of ["build-binaries.mjs", "binary-entry.ts.txt"])
    copyFileSync(resolve(root, "scripts", name), join(scripts, name));
  run(
    process.execPath,
    [join(scripts, "build-binaries.mjs"), archive, platform],
    archive,
    { PATH: process.env.PATH },
  );
  const binary = join(buildRoot, ".botanical/dist/fungi", `fungi-${platform}`);
  test("compiled launcher and embedded Bun ignore project bunfig preload and .env", () => {
    const result = run(binary, [], project);
    assert.throws(() => readFileSync(marker));
    assert.throws(() => readFileSync(contaminated));
    assert.match(result, /HOST_ENTRY_RAN:clean:/u);
  });
  test("compiled launcher still accepts an explicit host FUNGI_INSTALL", () => {
    const trusted = join(fixture, "explicit-install");
    const result = run(binary, [], project, { FUNGI_INSTALL: trusted });
    assert.ok(result.includes(`HOST_ENTRY_RAN:${trusted}:`), result);
    assert.throws(() => readFileSync(marker));
    assert.throws(() => readFileSync(contaminated));
  });
} finally {
  // Node's test callbacks run after the enclosing module has evaluated.
  process.once("exit", () => rmSync(fixture, { recursive: true, force: true }));
}
