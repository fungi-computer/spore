import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** Inspect installed ELF files, including optional npm runtime dependencies. */
export async function inspectGlibc(root, maximumMinor = 35) {
  const inventory = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (!entry.isFile()) continue;
      const file = await open(path, "r");
      const magic = Buffer.alloc(4);
      try {
        await file.read(magic, 0, 4, 0);
      } finally {
        await file.close();
      }
      if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
      const elf = spawnSync("readelf", ["--version-info", "--wide", path], {
        encoding: "utf8",
      });
      assert.equal(elf.status, 0, elf.stderr);
      const versions = [
        ...elf.stdout.matchAll(/\bGLIBC_(\d+)\.(\d+)(?:\.(\d+))?\b/g),
      ]
        .map((match) => match.slice(1).map((part) => Number(part ?? 0)))
        .sort(
          (left, right) =>
            left[0] - right[0] || left[1] - right[1] || left[2] - right[2],
        );
      const maximum = versions.at(-1);
      assert.ok(
        !maximum ||
          maximum[0] < 2 ||
          (maximum[0] === 2 && maximum[1] <= maximumMinor),
        `${relative(root, path)} exceeds glibc 2.${maximumMinor}`,
      );
      inventory.push({
        path: relative(root, path),
        glibc: maximum?.join(".") ?? null,
      });
    }
  }
  await visit(root);
  assert.ok(
    inventory.length > 0,
    "No installed ELF dependencies were inspected",
  );
  console.log(JSON.stringify({ installedElfRequirements: inventory }));
  return inventory;
}
