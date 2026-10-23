import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import { spawnSync } from "bun";
import { readInstalledLocalClientBuildId } from "@fungi.computer/truffle/service";

test("an installed archive-style launcher exposes its bootstrap identity through the real CLI without opening a Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-build-id-"));
  try {
    await writeFile(join(directory, "runtime.txt"), "owned archive payload\n");
    const archive = join(directory, "runtime.tar.gz");
    const packed = spawnSync(
      ["tar", "-czf", archive, "-C", directory, "runtime.txt"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(packed.exitCode).toBe(0);
    const buildId = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    const launcher = join(directory, "fungi");
    const cli = pathToFileURL(join(import.meta.dir, "../src/cli.tsx")).href;
    // This executable models the compiled bootstrap's existing archive-ID
    // environment. It is a query-seam fixture, not a compiled release proof.
    await writeFile(
      launcher,
      `#!/usr/bin/env bun
process.env.HOME = ${JSON.stringify(directory)};
process.env.XDG_CONFIG_HOME = ${JSON.stringify(join(directory, "config"))};
process.env.XDG_DATA_HOME = ${JSON.stringify(join(directory, "data"))};
process.env.XDG_CACHE_HOME = ${JSON.stringify(join(directory, "cache"))};
process.env.FUNGI_BUNDLED_BUILD_ID = ${JSON.stringify(buildId)};
const { runFungiCli } = await import(${JSON.stringify(cli)});
await runFungiCli(process.argv.slice(2));
`,
    );
    await chmod(launcher, 0o755);
    expect(
      createHash("sha256")
        .update(await readFile(launcher))
        .digest("hex"),
    ).not.toBe(buildId);
    expect(await readInstalledLocalClientBuildId(launcher)).toBe(buildId);
    expect(
      await Bun.file(join(directory, ".fungi/service/service.json")).exists(),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
