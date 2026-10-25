import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

for (const platform of [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
]) {
  const [os, cpu] = platform.split("-");
  test(`native ${platform} package resolves its engines and retains notices`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-native-package-"));
    try {
      for (const file of [
        "apps/tui/package.json",
        "apps/tui/scripts/bundle-native.mjs",
        "apps/tui/scripts/package-notices.mjs",
        "packages/cordyceps/native/apply-patch/notices.mjs",
        "packages/cordyceps/native/apply-patch/LICENSE.codex",
        "packages/cordyceps/native/bwrap/pin.mjs",
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
        if (os === "linux") {
          const { bwrapPin, seccompPin } =
            await import("../../../packages/cordyceps/native/bwrap/pin.mjs");
          const payload = "BWRAP_FIXTURE";
          const sha256 = createHash("sha256").update(payload).digest("hex");
          await writeFile(join(bin, "fungi-bwrap"), payload, { mode: 0o755 });
          await writeFile(join(bin, "fungi-bwrap.sha256"), `${sha256}\n`);
          const filter = "SECCOMP_FILTER_FIXTURE";
          const filterSha256 = createHash("sha256")
            .update(filter)
            .digest("hex");
          await writeFile(join(bin, "fungi-seccomp.bpf"), filter);
          await writeFile(
            join(bin, "fungi-seccomp.bpf.sha256"),
            `${filterSha256}\n`,
          );
          await writeFile(
            join(bin, "bwrap-build.json"),
            JSON.stringify({
              platform,
              upstream: bwrapPin,
              sha256,
              seccomp: { generator: seccompPin, sha256: filterSha256 },
              packages: [
                { name: "bubblewrap", texts: ["Fixture bubblewrap terms"] },
                {
                  name: "sandbox-runtime-seccomp-generator",
                  texts: ["Fixture seccomp terms"],
                },
              ],
            }),
          );
          for (const file of [
            "LICENSE.bubblewrap",
            "LICENSE.libcap",
            "LICENSE.sandbox-runtime",
            "SOURCE.bubblewrap.tar.xz",
          ])
            await writeFile(join(bin, file), "fixture distribution input");
          await mkdir(join(bin, "bwrap-build-source"));
          await writeFile(
            join(bin, "bwrap-build-source", "Dockerfile"),
            "fixture recipe",
          );
        }
      }
      const digest = (bytes) =>
        createHash("sha256").update(bytes).digest("hex");
      const anchors = join(
        root,
        "runtimes/local/src/private-local-native-digests.js",
      );
      await mkdir(dirname(anchors), { recursive: true });
      const expected = { patch: digest("PATCH_FIXTURE") };
      if (os === "linux") {
        expected.bwrap = digest("BWRAP_FIXTURE");
        expected.seccomp = digest("SECCOMP_FILTER_FIXTURE");
      }
      await writeFile(
        anchors,
        `export const nativeDigests = ${JSON.stringify({ [platform]: expected })};\n`,
      );
      const result = spawnSync(
        "node",
        [join(root, "apps/tui/scripts/bundle-native.mjs"), platform],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = join(root, `.botanical/fungi-cli-native-${platform}`);
      const manifestPath = join(output, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.name, `@fungi.computer/spore-native-${platform}`);
      assert.deepEqual(manifest.os, [os]);
      assert.deepEqual(manifest.cpu, [cpu]);
      assert.deepEqual(manifest.libc, os === "linux" ? ["glibc"] : undefined);
      assert.equal(
        manifest.bin["fungi-apply-patch"],
        "./bin/fungi-apply-patch",
      );
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
      if (os === "linux") {
        for (const name of ["fungi-bwrap.sha256", "fungi-seccomp.bpf.sha256"])
          assert.equal(manifest.files.includes(`bin/${name}`), false);
        assert.match(readme, /glibc 2\.35/);
        const bwrap = createRequire(manifestPath).resolve(
          `${manifest.name}/bin/fungi-bwrap`,
        );
        assert.equal(await readFile(bwrap, "utf8"), "BWRAP_FIXTURE");
        const filter = join(dirname(bwrap), "fungi-seccomp.bpf");
        assert(manifest.files.includes("bin/fungi-seccomp.bpf"));
        assert.equal(await readFile(filter, "utf8"), "SECCOMP_FILTER_FIXTURE");
        assert.match(
          await readFile(join(output, "THIRD_PARTY_NOTICES"), "utf8"),
          /Fixture bubblewrap terms/,
        );
        assert.match(
          await readFile(join(output, "THIRD_PARTY_NOTICES"), "utf8"),
          /Fixture seccomp terms/,
        );
        for (const bin of [
          join(root, `.botanical/native-build/${platform}/bin`),
          join(root, "runtimes/local/native/bin"),
        ])
          await writeFile(join(bin, "fungi-seccomp.bpf"), "TAMPERED_FILTER");
        const tamperedFilter = spawnSync(
          "node",
          [join(root, "apps/tui/scripts/bundle-native.mjs"), platform],
          { encoding: "utf8" },
        );
        assert.equal(
          tamperedFilter.status,
          1,
          "A changed filter must refuse packaging",
        );
        assert.match(tamperedFilter.stderr, /fungi-seccomp.bpf.*digest/);
        for (const bin of [
          join(root, `.botanical/native-build/${platform}/bin`),
          join(root, "runtimes/local/native/bin"),
        ])
          await writeFile(
            join(bin, "fungi-seccomp.bpf"),
            "SECCOMP_FILTER_FIXTURE",
          );
        for (const bin of [
          join(root, `.botanical/native-build/${platform}/bin`),
          join(root, "runtimes/local/native/bin"),
        ])
          await writeFile(join(bin, "fungi-bwrap"), "TAMPERED_FIXTURE");
        const tampered = spawnSync(
          "node",
          [join(root, "apps/tui/scripts/bundle-native.mjs"), platform],
          { encoding: "utf8" },
        );
        assert.equal(
          tampered.status,
          1,
          "A changed payload must refuse packaging",
        );
        assert.match(tampered.stderr, /digest/);
      } else {
        assert.match(readme, /macOS 13\.5/);
        assert.match(readme, cpu === "arm64" ? /Apple Silicon/ : /Intel Mac/);
        assert.equal(manifest.exports["./bin/fungi-bwrap"], undefined);
        assert(!manifest.files.includes("bin/fungi-bwrap"));
      }
      await writeFile(anchors, "export const nativeDigests = {};\n");
      const missing = spawnSync(
        "node",
        [join(root, "apps/tui/scripts/bundle-native.mjs"), platform],
        { encoding: "utf8" },
      );
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /no native digests/);
      await writeFile(
        anchors,
        `export const nativeDigests = ${JSON.stringify({ [platform]: { ...expected, patch: "0".repeat(64) } })};\n`,
      );
      const changed = spawnSync(
        "node",
        [join(root, "apps/tui/scripts/bundle-native.mjs"), platform],
        { encoding: "utf8" },
      );
      assert.notEqual(changed.status, 0);
      assert.match(changed.stderr, /digest mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
