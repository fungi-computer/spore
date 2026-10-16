import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCliNotices } from "./package-notices.mjs";

const platform = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (
  !["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"].includes(platform)
)
  throw new Error(`Unsupported CLI native package: ${platform}`);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const buildRoot =
  platform === `${process.platform}-${process.arch}`
    ? resolve(repository, "runtimes/local/native/bin")
    : resolve(repository, `.botanical/native-build/${platform}/bin`);
const build = JSON.parse(
  await readFile(resolve(buildRoot, "build.json"), "utf8"),
);
if (build.platform !== platform)
  throw new Error("Native build does not match the package target");
const output = resolve(repository, `.botanical/fungi-cli-native-${platform}`);
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "bin"), { recursive: true });
await copyFile(
  resolve(buildRoot, "fungi-apply-patch"),
  resolve(output, "bin/fungi-apply-patch"),
);
await copyFile(
  resolve(repository, "packages/cordyceps/native/apply-patch/LICENSE.codex"),
  resolve(output, "LICENSE.codex"),
);
await writeCliNotices({ repository, output, nativeBuilds: [build] });
const [os, cpu] = platform.split("-");
await writeFile(
  resolve(output, "package.json"),
  JSON.stringify(
    {
      name: `@fungi.computer/cli-native-${platform}`,
      version: "0.0.1",
      description: `Native patch engine for the Fungi CLI on ${platform}`,
      os: [os],
      cpu: [cpu],
      libc: os === "linux" ? ["glibc"] : undefined,
      bin: { "fungi-apply-patch": "./bin/fungi-apply-patch" },
      exports: { "./bin/fungi-apply-patch": "./bin/fungi-apply-patch" },
      files: [
        "bin/fungi-apply-patch",
        "LICENSE.codex",
        "THIRD_PARTY_NOTICES",
        "README.md",
      ],
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org",
      },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  resolve(output, "README.md"),
  `# Fungi CLI native engine (${platform})

This optional dependency supplies the native patch engine for
\`@fungi.computer/cli\`. Install the CLI to use it in a terminal or ACP editor.
${os === "linux" ? "Requires glibc 2.35 or newer." : `Requires ${cpu === "arm64" ? "Apple Silicon" : "an Intel Mac"} and macOS 13.5 or newer.`}

The engine uses pinned Codex sources with Fungi's rooted invocation wrapper.
Upstream terms are in \`LICENSE.codex\` and \`THIRD_PARTY_NOTICES\`.
`,
);
console.log(output);
