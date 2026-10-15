import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  installProofContainerTrap,
  proofNameLabel,
  proofOwnerPidLabel,
} from "../../../tooling/proof-containers/proof-janitor.mjs";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const { values, positionals: archives } = parseArgs({
  allowPositionals: true,
  options: { "acp-fixture": { type: "string" } },
});
if (!archives.length)
  throw new Error("Pass the packed CLI and native tarballs");
const builder = JSON.parse(
  await readFile(
    resolve(repository, ".botanical/native-build/linux-builder.json"),
    "utf8",
  ),
);
const owner = installProofContainerTrap("cli-glibc-235");
try {
  const args = [
    "run",
    "--rm",
    "--init",
    "--platform=linux/amd64",
    "--name",
    owner.workerName,
    "--label",
    `${proofOwnerPidLabel}=${owner.pid}`,
    "--label",
    `${proofNameLabel}=${owner.name}`,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--mount",
    `type=bind,src=${repository},dst=${repository},readonly`,
    "--mount",
    `type=bind,src=${dirname(dirname(process.execPath))},dst=/opt/node,readonly`,
    "--workdir",
    repository,
    "--env",
    "PATH=/opt/node/bin:/usr/bin:/bin",
    "--env",
    "HOME=/tmp/fungi-baseline-home",
    builder.image,
    "bash",
    "-euc",
    'test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.35"; getconf GNU_LIBC_VERSION; node apps/tui/scripts/prove-bundle.mjs "$@"',
    "baseline-proof",
    ...archives.map((archive) => resolve(archive)),
    ...(values["acp-fixture"]
      ? ["--acp-fixture", resolve(values["acp-fixture"])]
      : []),
  ];
  await new Promise((accept, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) accept();
      else
        reject(
          new Error(`glibc 2.35 qualification failed (${signal ?? code})`),
        );
    });
  });
} finally {
  owner.cleanup();
}
