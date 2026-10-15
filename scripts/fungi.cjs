#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { release, cpus } = require("node:os");

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
const supported =
  runtimes[platform] !== undefined &&
  !translated &&
  (process.platform !== "linux" || major > 2 || (major === 2 && minor >= 35)) &&
  (process.platform !== "darwin" ||
    darwinMajor > 22 ||
    (darwinMajor === 22 && darwinMinor >= 6));
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
      ? "Use arm64 Node on Apple Silicon and reinstall the CLI with npm install -g @fungi.computer/cli --include=optional. The Intel Bun runtime is not supported under Rosetta."
      : "Fungi CLI needs Linux x64/arm64 with glibc 2.35+, or macOS 13.5+ on Apple Silicon or Intel.",
  );
  process.exit(1);
}
const nativePackage = `@fungi.computer/cli-native-${platform}`;
let bun;
try {
  require.resolve(`${nativePackage}/bin/fungi-apply-patch`);
  bun = require.resolve(runtimes[platform]);
} catch (cause) {
  throw new Error(
    "Fungi CLI could not load its native dependencies. Reinstall with npm install -g @fungi.computer/cli --include=optional.",
    { cause },
  );
}
const cli = resolve(__dirname, "cli.js");
const buildId = createHash("sha256").update(readFileSync(cli)).digest("hex");
const child = spawnSync(bun, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    FUNGI_BUNDLED_CLI: cli,
    FUNGI_BUNDLED_BUILD_ID: buildId,
    FUNGI_LAUNCHER: __filename,
    FUNGI_LAUNCHER_NODE: process.execPath,
  },
});
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
process.exitCode = child.status ?? 1;
