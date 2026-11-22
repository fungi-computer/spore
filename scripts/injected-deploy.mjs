import { spawnSync } from "node:child_process";
import { copyFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

// pnpm deploy imports injected workspace packages (@scope+name@file+...) into
// the output by hardlink whatever package-import-method says, so each source
// dist file, such as Truffle's private-local-sandbox.js, gains a second link.
// The Local sandbox policy refuses a hardlinked file, so that would break the
// source checkout. Replacing each linked output file with an independent copy
// drops the source file back to one link and keeps the deployed graph intact.
export function packageLocalDeployArguments(destination) {
  return [
    "--filter",
    "@fungi.computer/spore",
    "deploy",
    "--prod",
    "--legacy",
    destination,
  ];
}

async function detach(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await detach(path);
    else if (entry.isFile() && (await stat(path)).nlink > 1) {
      const copy = `${path}.detached`;
      await copyFile(path, copy);
      await rename(copy, path);
    }
  }
}

export async function detachInjectedWorkspaceFiles(destination) {
  const store = join(destination, "node_modules/.pnpm");
  for (const entry of await readdir(store, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name.includes("@file+"))
      await detach(join(store, entry.name));
}

export async function deployDetached(deployArguments, destination, options) {
  const deployed = spawnSync("pnpm", deployArguments, {
    ...options,
    stdio: "inherit",
  });
  if (deployed.error !== undefined) throw deployed.error;
  if (deployed.status !== 0)
    throw new Error(`pnpm deploy failed (${String(deployed.status)})`);
  await detachInjectedWorkspaceFiles(destination);
}
