import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCliNotices } from "./package-notices.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(root, "../..");
const output = resolve(repository, ".botanical/fungi-cli-package");
const metafile = resolve(repository, ".botanical/fungi-cli-metafile.json");
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "dist/internal"), { recursive: true });
await mkdir(resolve(output, "native/apply-patch"), { recursive: true });
const build = spawnSync(
  "bun",
  [
    "build",
    resolve(root, "dist/cli.js"),
    "--target=bun",
    "--outfile",
    resolve(output, "dist/cli.js"),
    "--external=miniflare",
    "--external=@opentui/core",
    `--metafile=${metafile}`,
  ],
  { cwd: repository, stdio: "inherit" },
);
if (build.error !== undefined) throw build.error;
if (build.status !== 0) throw new Error("CLI bundle failed");
await copyFile(
  resolve(
    repository,
    "runtimes/local/dist/internal/private-workerd-sandbox-worker.mjs",
  ),
  resolve(output, "dist/internal/private-workerd-sandbox-worker.mjs"),
);
await copyFile(
  resolve(repository, "packages/cordyceps/dist/computerd.cjs"),
  resolve(output, "dist/internal/computerd.cjs"),
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
  resolve(repository, "runtimes/local/native/apply-patch/LICENSE.codex"),
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
      name: "@fungi.computer/cli",
      // The public CLI's inaugural release is independent of the private TUI.
      version: "0.0.1",
      description: "Fungi local agent for terminals and ACP editors",
      homepage: "https://docs.fungi.computer/guides/use-fungi-in-your-editor/",
      bin: { fungi: "dist/fungi.cjs" },
      files: [
        "README.md",
        "THIRD_PARTY_NOTICES",
        "dist/cli.js",
        "dist/tool-sigil-images.json",
        "dist/fungi.cjs",
        "dist/internal/private-workerd-sandbox-worker.mjs",
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
      },
      optionalDependencies: {
        "@fungi.computer/cli-native-linux-x64": "0.0.1",
        "@fungi.computer/cli-native-linux-arm64": "0.0.1",
        "@fungi.computer/cli-native-darwin-arm64": "0.0.1",
        "@fungi.computer/cli-native-darwin-x64": "0.0.1",
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
console.log(output);
