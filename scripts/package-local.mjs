import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import console from "node:console";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import process from "node:process";
import { expectFileAccess, isMissingFileError } from "./file-probe.mjs";

const tuiRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(tuiRoot, "../..");
const require = createRequire(import.meta.url);
const destinationArguments = process.argv
  .slice(2)
  .filter((value) => value !== "--");
const destinationArgument = destinationArguments[0];

if (destinationArgument === undefined || destinationArguments.length !== 1)
  throw new Error("Usage: pnpm --dir apps/tui package:local -- <destination>");

const destination = resolve(process.cwd(), destinationArgument);
const nativeRelative =
  "node_modules/@fungi.computer/local/native/bin/fungi-apply-patch";
const nativeSource = resolve(
  repositoryRoot,
  "runtimes/local/native/bin/fungi-apply-patch",
);
const cliSource = resolve(tuiRoot, "dist/cli.js");
const bunSource = await realpath(
  resolve(
    dirname(require.resolve("bun/package.json", { paths: [tuiRoot] })),
    "bin/bun.exe",
  ),
);

await expectFileAccess(
  nativeSource,
  constants.X_OK,
  "Local native patch engine is absent; run pnpm --filter @fungi.computer/local build:native before packaging fungi",
);
await expectFileAccess(
  cliSource,
  constants.R_OK,
  "Built TUI is absent; build the TUI dependency closure before packaging fungi",
);
try {
  await stat(destination);
  throw new Error(`Package destination already exists: ${destination}`);
} catch (cause) {
  if (!isMissingFileError(cause)) throw cause;
}

const deployed = spawnSync(
  "pnpm",
  [
    "--filter",
    "@fungi.computer/tui",
    "deploy",
    "--prod",
    "--legacy",
    destination,
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);
if (deployed.error !== undefined) throw deployed.error;
if (deployed.status !== 0)
  throw new Error(`pnpm deploy failed (${String(deployed.status)})`);

const nativeInstalled = resolve(destination, nativeRelative);
await expectFileAccess(
  nativeInstalled,
  constants.X_OK,
  `Deployed fungi is incomplete: executable ${nativeRelative} is absent`,
);
// computerd runs under the user's Node for `fungi computer attach`; the
// deployed bundle, a dependency of Local, is self-contained and native-free.
// pnpm links Local's dependencies beside its real directory, not the symlink.
const computerdInstalled = createRequire(
  await realpath(
    resolve(destination, "node_modules/@fungi.computer/local/package.json"),
  ),
).resolve("@fungi.computer/cordyceps/cli");
await access(computerdInstalled, constants.R_OK);
let ptyBinary;
if (process.platform === "darwin") {
  const ptyBinding = resolve(
    destination,
    "node_modules/@opencode-ai/pty/index.js",
  );
  ({ binaryPath: ptyBinary } = await import(pathToFileURL(ptyBinding).href));
  if (ptyBinary === undefined)
    throw new Error("Deployed fungi has no Mac PTY binary");
  await access(ptyBinary, constants.X_OK);
}
const bunInstalled = resolve(destination, ".runtime/bun");
await mkdir(dirname(bunInstalled), { recursive: true });
await copyFile(bunSource, bunInstalled);
await access(bunInstalled, constants.X_OK);

const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const evidence = {
  destination,
  nativePatchSha256: await sha256(nativeInstalled),
  bunSha256: await sha256(bunInstalled),
  cliSha256: await sha256(resolve(destination, "dist/cli.js")),
  computerdSha256: await sha256(computerdInstalled),
};
if (ptyBinary !== undefined) evidence.ptySha256 = await sha256(ptyBinary);
console.log(JSON.stringify(evidence, undefined, 2));
