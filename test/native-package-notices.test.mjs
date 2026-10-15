import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { test } from "bun:test";
import { nativeNotices } from "../../../runtimes/local/scripts/native-notices.mjs";
import { writeCliNotices } from "../scripts/package-notices.mjs";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

test("cached native notices package without the compiler's source checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-native-notices-"));
  try {
    const source = join(root, "source");
    const crate = join(source, "engine");
    const output = join(root, "package");
    await mkdir(crate, { recursive: true });
    await mkdir(output);
    await writeFile(join(source, "LICENSE"), "Native fixture notice\n");
    const cached = JSON.stringify({
      platform: "darwin-arm64",
      packages: await nativeNotices(
        [
          {
            package_id: `path+${pathToFileURL(crate).href}#fixture-native@1.0.0`,
            manifest_path: join(crate, "Cargo.toml"),
          },
        ],
        source,
      ),
    });
    assert.equal(cached.includes(source), false);
    await rm(source, { recursive: true });
    await writeCliNotices({
      repository,
      output,
      nativeBuilds: [JSON.parse(cached)],
    });
    const notices = await readFile(join(output, "THIRD_PARTY_NOTICES"), "utf8");
    assert.match(notices, /fixture-native@1\.0\.0/);
    assert.match(notices, /Native fixture notice/);
    await assert.rejects(
      writeCliNotices({
        repository,
        output,
        nativeBuilds: [
          {
            packages: [{ name: "missing-native@1.0.0", texts: [] }],
          },
        ],
      }),
      /No upstream license text found for: missing-native@1\.0\.0/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
