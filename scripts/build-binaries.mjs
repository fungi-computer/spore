import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(root, ".botanical/dist/fungi");
const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const [input, target = `${process.platform}-${process.arch}`] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--");
if (!input || (target !== "all" && !targets.includes(target)))
  throw new Error(
    "Usage: build-binaries.mjs <installed-cli-directory> [linux-x64|linux-arm64|darwin-x64|darwin-arm64]; or <platform-staging-root> all",
  );
await mkdir(output, { recursive: true });
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
for (const platform of target === "all" ? targets : [target]) {
  const source = resolve(input, ...(target === "all" ? [platform] : []));
  const manifest = JSON.parse(
    await readFile(resolve(source, "package.json"), "utf8"),
  );
  const [os, arch] = platform.split("-");
  if (
    manifest.name !== "@fungi.computer/cli" ||
    !manifest.optionalDependencies?.[`@fungi.computer/cli-native-${platform}`]
  )
    throw new Error(
      `Stage the CLI and native assets on ${platform} first; package metadata does not match`,
    );
  const native = os === "darwin" ? "libopentui.dylib" : "libopentui.so";
  await access(
    resolve(source, `node_modules/@opentui/core-${platform}/${native}`),
  );
  await access(
    resolve(
      source,
      `node_modules/@fungi.computer/cli-native-${platform}/bin/fungi-apply-patch`,
    ),
    constants.X_OK,
  );
  await access(resolve(source, "node_modules/miniflare/package.json"));
  const workerdTarget = `${os}-${arch === "x64" ? "64" : "arm64"}`;
  await access(
    resolve(
      source,
      `node_modules/@cloudflare/workerd-${workerdTarget}/bin/workerd`,
    ),
    constants.X_OK,
  );
  await access(resolve(source, "computerd-loopback.cjs"));
  const temporary = await mkdtemp(resolve(output, ".build-"));
  try {
    const staged = resolve(temporary, "package");
    await cp(source, staged, { recursive: true, dereference: true });
    // Standalone Bun cannot currently resolve the extracted package's bare
    // imports (oven-sh/bun#27058). Reuse the npm launcher's pinned runtime.
    const bunTarget = `${os}-${arch === "arm64" ? "aarch64" : "x64"}`;
    await copyFile(
      resolve(staged, `node_modules/@oven/bun-${bunTarget}/bin/bun`),
      resolve(staged, "native/bin/bun"),
    );
    await rm(resolve(staged, "node_modules/@oven"), {
      recursive: true,
      force: true,
    });
    // computerd's retained contract requires Node, even though the agent CLI
    // runs on Bun. Embed the native build host's Node instead of requiring PATH.
    if (platform === `${process.platform}-${process.arch}`)
      await copyFile(process.execPath, resolve(staged, "native/bin/node"));
    await access(resolve(staged, "native/bin/node"), constants.X_OK);
    // Dereference npm package links; preserve modes for native executables.
    run("tar", [
      "-czhf",
      resolve(temporary, "runtime.tar.gz"),
      "-C",
      staged,
      ".",
    ]);
    const digest = createHash("sha256")
      .update(await readFile(resolve(temporary, "runtime.tar.gz")))
      .digest("hex");
    const entry = (
      await readFile(
        resolve(dirname(fileURLToPath(import.meta.url)), "binary-entry.ts.txt"),
        "utf8",
      )
    ).replace("FUNGI_ARCHIVE_HASH", digest);
    await writeFile(resolve(temporary, "entry.ts"), entry);
    const name = `fungi-${platform}`;
    run("bun", [
      "build",
      "--compile",
      `--target=bun-${platform}`,
      resolve(temporary, "entry.ts"),
      "--outfile",
      resolve(output, name),
    ]);
    const checksum = createHash("sha256")
      .update(await readFile(resolve(output, name)))
      .digest("hex");
    await writeFile(
      resolve(output, `${name}.sha256`),
      `${checksum}  ${name}\n`,
    );
    console.log(`Built ${name} with runtime assets; SHA-256 ${checksum}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
