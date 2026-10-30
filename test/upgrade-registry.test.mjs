import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "bun:test";
import { startUpgradeRegistry } from "./upgrade-registry.fixture.mjs";

const execute = promisify(execFile);
const { fetch } = globalThis;

test("the published updater's HTTPS registry lookup reaches the local candidate without disabling TLS", async () => {
  const root = await mkdtemp(join(tmpdir(), "upgrade-registry-"));
  let registry;
  try {
    await mkdir(join(root, "package"));
    await writeFile(
      join(root, "package", "package.json"),
      JSON.stringify({
        name: "@fungi.computer/spore",
        version: "0.7.0-candidate.test",
      }),
    );
    const archive = join(root, "candidate.tgz");
    await execute("tar", ["-czf", archive, "-C", root, "package"]);
    registry = await startUpgradeRegistry(root, [archive]);
    const child = await execute(
      process.execPath,
      [
        "--config=/dev/null",
        "--no-env-file",
        "--eval",
        'console.log(await (await fetch("https://registry.npmjs.org/@fungi.computer%2fspore/latest")).text())',
      ],
      {
        env: { PATH: process.env.PATH, ...registry.env },
        timeout: 5_000,
      },
    );
    assert.equal(JSON.parse(child.stdout).version, "0.7.0-candidate.test");
    assert.ok(registry.requests.includes("/@fungi.computer/spore/latest"));
    const metadata = JSON.parse(child.stdout);
    assert.deepEqual(
      Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer()),
      await readFile(archive),
    );
    const head = await fetch(metadata.dist.tarball, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const refused = await fetch(metadata.dist.tarball, { method: "POST" });
    assert.equal(refused.status, 405);
  } finally {
    await registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});
