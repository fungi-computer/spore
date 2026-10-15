import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { packProofPackage } from "../../../tooling/repository/scripts/proof-tarball.mjs";
import {
  runCommand,
  commandSucceeded,
} from "../../../tooling/repository/src/core/command-runner.ts";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const packed = await packProofPackage(
  resolve(root, ".botanical/fungi-cli-package"),
);
let native;
try {
  native = await packProofPackage(
    resolve(
      root,
      `.botanical/fungi-cli-native-${process.platform}-${process.arch}`,
    ),
  );
  const result = await runCommand(
    [
      "bash",
      resolve(
        root,
        ".agents/skills/orchestrate-multi-lane-work/scripts/run-proof.sh",
      ),
      process.execPath,
      "apps/tui/scripts/prove-bundle.mjs",
      packed.tarball,
      native.tarball,
    ],
    { cwd: root },
  );
  process.stdout.write(result.stdout);
  if (!commandSucceeded(result))
    throw new Error(`Packed CLI qualification failed: ${result.stderr}`);
} finally {
  await rm(packed.work, { recursive: true, force: true });
  if (native) await rm(native.work, { recursive: true, force: true });
}
