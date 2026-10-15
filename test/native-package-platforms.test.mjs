import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { test } from "bun:test";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

for (const cpu of ["arm64", "x64"]) {
  test(`native macOS ${cpu} package resolves its patch engine and retains notices`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-native-package-"));
    try {
      for (const file of [
        "apps/tui/scripts/bundle-native.mjs",
        "apps/tui/scripts/package-notices.mjs",
        "runtimes/local/scripts/native-notices.mjs",
        "runtimes/local/native/apply-patch/LICENSE.codex",
      ]) {
        const target = join(root, file);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(repository, file), target);
      }
      await cp(
        join(repository, "apps/tui/npm/licenses"),
        join(root, "apps/tui/npm/licenses"),
        { recursive: true },
      );
      const platform = `darwin-${cpu}`;
      // Cached compiler output is the packager's input. No compiler or native
      // executable is claimed by this fixture; real cross-build proofs are separate.
      for (const bin of [
        join(root, `.botanical/native-build/${platform}/bin`),
        join(root, "runtimes/local/native/bin"),
      ]) {
        await mkdir(bin, { recursive: true });
        await writeFile(join(bin, "fungi-apply-patch"), "PATCH_FIXTURE", {
          mode: 0o755,
        });
        await writeFile(
          join(bin, "build.json"),
          JSON.stringify({
            platform,
            packages: [
              {
                name: "codex-apply-patch@fixture",
                texts: ["Fixture upstream terms"],
              },
            ],
          }),
        );
      }
      const result = spawnSync(
        "node",
        [join(root, "apps/tui/scripts/bundle-native.mjs"), platform],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = join(root, `.botanical/fungi-cli-native-${platform}`);
      const manifestPath = join(output, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.name, `@fungi.computer/cli-native-${platform}`);
      assert.deepEqual(manifest.os, ["darwin"]);
      assert.deepEqual(manifest.cpu, [cpu]);
      assert.equal(manifest.libc, undefined);
      const resolved = createRequire(manifestPath).resolve(
        `${manifest.name}/bin/fungi-apply-patch`,
      );
      assert.equal(await readFile(resolved, "utf8"), "PATCH_FIXTURE");
      assert.equal((await stat(resolved)).mode & 0o111, 0o111);
      assert.match(
        await readFile(join(output, "THIRD_PARTY_NOTICES"), "utf8"),
        /Fixture upstream terms/,
      );
      const readme = await readFile(join(output, "README.md"), "utf8");
      assert.match(readme, /macOS 13\.5/);
      assert.match(readme, cpu === "arm64" ? /Apple Silicon/ : /Intel Mac/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
