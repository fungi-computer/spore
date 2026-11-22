import process from "node:process";
import { resolve } from "node:path";
import { deployDetached } from "./injected-deploy.mjs";

export function nativeFrameDeployArguments(destination) {
  return [
    "--filter",
    "@fungi.computer/spore",
    "deploy",
    "--config.inject-workspace-packages=true",
    destination,
  ];
}

if (import.meta.main) {
  const destination = process.argv[2];
  if (destination === undefined || process.argv.length !== 3)
    throw new Error(
      "Usage: node scripts/native-frame-deploy.mjs <destination>",
    );
  const resolved = resolve(destination);
  await deployDetached(nativeFrameDeployArguments(resolved), resolved);
}
