import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
import { transform } from "esbuild";
import { writeCliNotices } from "./package-notices.mjs";

async function transformFile(source, destination) {
  const { code } = await transform(await readFile(source, "utf8"), {
    format: "esm",
    minify: true,
    legalComments: "eof",
    target: "es2024",
  });
  await writeFile(destination, code);
}

const root = fileURLToPath(new URL("../", import.meta.url));
// The TUI's package.json version is the one source of truth for the published
// @fungi.computer/spore and its native packages, so `fungi --version` reads the
// same value from source and from the packed launcher.
const { version } = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const repository = resolve(root, "../..");
// Refresh the in-bundle trust anchor after all available platform builds.
const anchors = spawnSync(
  process.execPath,
  [
    resolve(repository, "runtimes/local/scripts/generate-native-digests.mjs"),
    "--cross",
  ],
  { cwd: repository, stdio: "inherit" },
);
if (anchors.error !== undefined) throw anchors.error;
if (anchors.status !== 0) throw new Error("Native digest generation failed");
await copyFile(
  resolve(repository, "runtimes/local/src/private-local-native-digests.js"),
  resolve(repository, "runtimes/local/dist/private-local-native-digests.js"),
);
const output = resolve(repository, ".botanical/fungi-cli-package");
const metafile = resolve(repository, ".botanical/fungi-cli-metafile.json");
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "dist/internal"), { recursive: true });
await mkdir(resolve(output, "dist/seatbelt"), { recursive: true });
await mkdir(resolve(output, "native/apply-patch"), { recursive: true });
const build = spawnSync(
  "bun",
  [
    "build",
    resolve(root, "dist/cli.js"),
    "--target=bun",
    // Ship one minified file: no comments or module paths from the private
    // source tree, and no source map.
    "--minify",
    // Minification alone leaves React DEV performance timing tracks enabled.
    "--define",
    'process.env.NODE_ENV="production"',
    "--sourcemap=none",
    "--outfile",
    resolve(output, "dist/cli.js"),
    "--external=miniflare",
    "--external=@opentui/core",
    "--external=@napi-rs/keyring",
    `--metafile=${metafile}`,
  ],
  { cwd: repository, stdio: "inherit" },
);
if (build.error !== undefined) throw build.error;
if (build.status !== 0) throw new Error("CLI bundle failed");
// Local's sandbox worker is already bundled; minify it so no module path
// comments from the private source tree ship. License comments stay at the end.
await transformFile(
  resolve(
    repository,
    "runtimes/local/dist/internal/private-workerd-sandbox-worker.mjs",
  ),
  resolve(output, "dist/internal/private-workerd-sandbox-worker.mjs"),
);
// Local shrinks each image in a throwaway worker thread, loaded from this
// path beside dist/cli.js; it carries Photon's inlined WebAssembly.
await transformFile(
  resolve(
    repository,
    "runtimes/local/dist/internal/local-image-fit-worker.mjs",
  ),
  resolve(output, "dist/internal/local-image-fit-worker.mjs"),
);
await copyFile(
  resolve(repository, "packages/cordyceps/dist/computerd.cjs"),
  resolve(output, "dist/internal/computerd.cjs"),
);
await copyFile(
  resolve(repository, "runtimes/local/dist/seatbelt/safe-base.sbpl"),
  resolve(output, "dist/seatbelt/safe-base.sbpl"),
);
await copyFile(
  resolve(root, "scripts/fungi.cjs"),
  resolve(output, "dist/fungi.cjs"),
);
await copyFile(
  resolve(repository, "runtimes/local/computerd-loopback.cjs"),
  resolve(output, "computerd-loopback.cjs"),
);
await copyFile(
  resolve(repository, "packages/cordyceps/native/apply-patch/LICENSE.codex"),
  resolve(output, "native/apply-patch/LICENSE.codex"),
);
await copyFile(resolve(root, "npm/README.md"), resolve(output, "README.md"));
await copyFile(
  resolve(root, "dist/tool-sigil-images.json"),
  resolve(output, "dist/tool-sigil-images.json"),
);
await writeCliNotices({ repository, output, metafile });
await writeFile(
  resolve(output, "package.json"),
  JSON.stringify(
    {
      name: "@fungi.computer/spore",
      version,
      description: "Fungi local agent for terminals and ACP editors",
      homepage: "https://docs.fungi.computer/guides/use-fungi-in-your-editor/",
      bin: { fungi: "dist/fungi.cjs" },
      files: [
        "README.md",
        "THIRD_PARTY_NOTICES",
        "dist/cli.js",
        "dist/seatbelt/safe-base.sbpl",
        "dist/tool-sigil-images.json",
        "dist/fungi.cjs",
        "dist/internal/private-workerd-sandbox-worker.mjs",
        "dist/internal/local-image-fit-worker.mjs",
        "dist/internal/computerd.cjs",
        "native/apply-patch/LICENSE.codex",
        "computerd-loopback.cjs",
      ],
      engines: { node: ">=22.13" },
      // Keep the Node diagnostic launcher installable on unsupported hosts.
      // Native optional packages retain their own OS/CPU constraints.
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org",
      },
      dependencies: {
        miniflare: "5.20260828.0-alpha",
        "@opentui/core": "0.5.10",
        "@napi-rs/keyring": "2.1.2",
        "@opencode-ai/pty": "0.3.0",
      },
      optionalDependencies: {
        "@fungi.computer/spore-native-linux-x64": version,
        "@fungi.computer/spore-native-linux-arm64": version,
        "@fungi.computer/spore-native-darwin-arm64": version,
        "@fungi.computer/spore-native-darwin-x64": version,
        "@oven/bun-darwin-x64": "1.4.2",
        "@oven/bun-darwin-aarch64": "1.4.2",
        "@oven/bun-linux-x64": "1.4.2",
        "@oven/bun-linux-aarch64": "1.4.2",
        "@cloudflare/workerd-darwin-64": "1.20260828.1",
        "@cloudflare/workerd-darwin-arm64": "1.20260828.1",
        "@cloudflare/workerd-linux-64": "1.20260828.1",
        "@cloudflare/workerd-linux-arm64": "1.20260828.1",
      },
    },
    null,
    2,
  ) + "\n",
);
// A bundle must not carry this checkout's paths or the private Local source
// layout; fail the build rather than ship them.
// Bun inlines a CommonJS module's absolute `__filename`; write-file-atomic
// uses it only to seed temporary file names. Keep it package-relative.
for (const file of [
  "dist/internal/private-workerd-sandbox-worker.mjs",
  "dist/internal/local-image-fit-worker.mjs",
]) {
  const text = await readFile(resolve(output, file), "utf8");
  if (text.includes("runtimes/local") || text.includes(repository))
    throw new Error(`${file} contains a private path`);
}
const bundle = (
  await readFile(resolve(output, "dist/cli.js"), "utf8")
).replaceAll(`__filename="${repository}/`, `__filename="/`);
await writeFile(resolve(output, "dist/cli.js"), bundle);
for (const leak of [repository, "runtimes/local/src"])
  if (bundle.includes(leak))
    throw new Error(`CLI bundle contains a private path: ${leak}`);
if (/sourceMappingURL/u.test(bundle))
  throw new Error("CLI bundle must not reference a source map");
await writeSizeReport(output, metafile);
console.log(output);

/** Bytes per workspace or npm package inside dist/cli.js, largest first. */
async function writeSizeReport(packageRoot, metafilePath) {
  const { inputs, outputs } = JSON.parse(await readFile(metafilePath, "utf8"));
  const owners = new Map();
  for (const [path, input] of Object.entries(inputs)) {
    const modules = path.lastIndexOf("node_modules/");
    const owner =
      modules >= 0
        ? path
            .slice(modules + "node_modules/".length)
            .split("/")
            .slice(0, path.slice(modules).includes("/@") ? 2 : 1)
            .join("/")
        : path.split("/").slice(0, 2).join("/");
    owners.set(owner, (owners.get(owner) ?? 0) + input.bytes);
  }
  const files = {};
  for (const file of [
    "dist/cli.js",
    "dist/fungi.cjs",
    "dist/tool-sigil-images.json",
    "dist/internal/private-workerd-sandbox-worker.mjs",
    "dist/internal/local-image-fit-worker.mjs",
    "dist/internal/computerd.cjs",
  ])
    files[file] = (await stat(resolve(packageRoot, file))).size;
  const report = {
    files,
    total: Object.values(files).reduce((sum, size) => sum + size, 0),
    bundledOutputBytes: Object.values(outputs).reduce(
      (sum, item) => sum + item.bytes,
      0,
    ),
    largestInputs: [...owners.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 25)
      .map(([owner, bytes]) => ({ owner, bytes })),
  };
  const reportPath = resolve(repository, ".botanical/fungi-cli-size.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(2)} MB`;
  console.log(
    `fungi CLI bundle: dist/cli.js ${megabytes(files["dist/cli.js"])}, package files ${megabytes(report.total)}; report ${reportPath}`,
  );
}
