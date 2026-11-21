#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { release, cpus } = require("node:os");

// Match the published package's Node engine before loading platform dependencies.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error(
    `Fungi CLI needs Node 22.13 or newer; found ${process.versions.node}. Install Node 22.13 or newer, reinstall with npm i -g @fungi.computer/spore, then run fungi.`,
  );
  process.exit(1);
}

const runtimes = {
  "linux-x64": "@oven/bun-linux-x64/bin/bun",
  "linux-arm64": "@oven/bun-linux-aarch64/bin/bun",
  "darwin-arm64": "@oven/bun-darwin-aarch64/bin/bun",
  "darwin-x64": "@oven/bun-darwin-x64/bin/bun",
};
const platform = `${process.platform}-${process.arch}`;
// Node runs this check before resolving or loading any native dependency.
const glibc =
  process.platform === "linux"
    ? process.report.getReport().header.glibcVersionRuntime
    : undefined;
const [major, minor] = (glibc ?? "").split(".").map(Number);
const [darwinMajor, darwinMinor] =
  process.platform === "darwin" ? release().split(".").map(Number) : [];
const hostCpus =
  process.platform === "darwin" && process.arch === "x64" ? cpus() : [];
const translated =
  process.platform === "darwin" &&
  process.arch === "x64" &&
  (hostCpus.length === 0 || hostCpus.some(({ model }) => /Apple/.test(model)));
// The bundled Bun runtime needs glibc 2.17; the OS sandbox's native package
// needs 2.35. Between them the CLI runs, in Full access only: the Local service
// (runtimes/local private-local-host-support.ts) applies the same 2.35 line and
// never uses the native package there.
const glibcAtLeast = (wantedMajor, wantedMinor) =>
  major > wantedMajor || (major === wantedMajor && minor >= wantedMinor);
const supported =
  runtimes[platform] !== undefined &&
  !translated &&
  (process.platform !== "linux" || glibcAtLeast(2, 17)) &&
  (process.platform !== "darwin" ||
    darwinMajor > 22 ||
    (darwinMajor === 22 && darwinMinor >= 6));
const sandboxHost = process.platform !== "linux" || glibcAtLeast(2, 35);
if (!supported) {
  if (process.argv[2] === "doctor") {
    console.log(`Platform: ${process.platform} ${process.arch}`);
    console.log(
      `glibc: ${process.platform === "linux" ? (glibc ?? "not detected (musl or unknown libc)") : "not applicable"}`,
    );
    console.log("Sign-in: not checked on an unsupported platform");
  }
  console.error(
    translated
      ? "Use arm64 Node on Apple Silicon and reinstall the CLI with npm install -g @fungi.computer/spore --include=optional. The Intel Bun runtime is not supported under Rosetta."
      : "Fungi CLI needs Linux x64/arm64 with glibc 2.17+ (2.35+ for the OS sandbox), or macOS 13.5+ on Apple Silicon or Intel.",
  );
  process.exit(1);
}
const nativePackage = `@fungi.computer/spore-native-${platform}`;
const sporeVersion = require("../package.json").version;
function nativeResolution() {
  try {
    require.resolve(`${nativePackage}/bin/fungi-apply-patch`);
    return { kind: "ready" };
  } catch {
    return { kind: "missing" };
  }
}
// A host that cannot run the sandbox does not use the native package: whether
// or not npm installed it, Full access runs and the sandboxed modes are refused.
if (sandboxHost && nativeResolution().kind === "missing") {
  console.error(
    `Fungi's native package for ${platform} is missing or doesn't match this version. Reinstall: npm i -g @fungi.computer/spore@${sporeVersion} --include=optional`,
  );
  process.exit(1);
}
const bun = require.resolve(runtimes[platform]);
const cli = resolve(__dirname, "cli.js");
const buildId = createHash("sha256").update(readFileSync(cli)).digest("hex");
// Bun otherwise loads the project's bunfig.toml preload and .env into this
// unsandboxed host process before the CLI can establish Agent authority.
const child = spawnSync(
  bun,
  ["--config=/dev/null", "--no-env-file", cli, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      FUNGI_BUNDLED_CLI: cli,
      FUNGI_BUNDLED_BUILD_ID: buildId,
      FUNGI_SPORE_VERSION: sporeVersion,
      FUNGI_LAUNCHER: __filename,
      FUNGI_LAUNCHER_NODE: process.execPath,
    },
  },
);
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
process.exitCode = child.status ?? 1;
