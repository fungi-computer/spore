import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { test } from "bun:test";
import { nativeNotices } from "../../../packages/cordyceps/native/apply-patch/notices.mjs";
import { writeCliNotices } from "../scripts/package-notices.mjs";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

async function prepareNotices(root) {
  const output = join(root, "package");
  await mkdir(output);
  await mkdir(join(root, "apps/tui/npm"), { recursive: true });
  await cp(
    join(repository, "apps/tui/npm/licenses"),
    join(root, "apps/tui/npm/licenses"),
    { recursive: true },
  );
  const retained = "apps/tui/src/button/opencode-pty-transport.LICENSE";
  await mkdir(dirname(join(root, retained)), { recursive: true });
  await cp(join(repository, retained), join(root, retained));
  for (const file of [
    "runtimes/local/dist/internal/sandbox-metafile.json",
    "runtimes/local/dist/internal/image-fit-metafile.json",
    "runtimes/local/dist/internal/service-worker-metafile.json",
    "packages/cordyceps/dist/metafile.json",
  ]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), JSON.stringify({ inputs: {} }));
  }
  return output;
}

test("bundled notices are independent of equal-name version discovery order", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-notice-order-"));
  try {
    const output = await prepareNotices(root);
    const inputs = [];
    const versions = ["3.0.6", "4.1.0"];
    for (const version of versions) {
      const directory = join(root, "dependencies", version);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: "eventsource-parser", version }),
      );
      await writeFile(
        join(directory, "LICENSE"),
        `Fixture notice ${version}\n`,
      );
      await writeFile(join(directory, "index.js"), "export {};\n");
      inputs.push(`dependencies/${version}/index.js`);
    }
    const notices = [];
    for (const order of [inputs, inputs.toReversed()]) {
      await writeFile(
        join(root, "graph.json"),
        JSON.stringify({
          inputs: Object.fromEntries(
            order.map((input) => [input, { bytes: 0, imports: [] }]),
          ),
        }),
      );
      await writeCliNotices({
        repository: root,
        output,
        metafile: "graph.json",
      });
      notices.push(await readFile(join(output, "THIRD_PARTY_NOTICES"), "utf8"));
    }
    assert.equal(notices[0], notices[1]);
    for (const version of versions) {
      assert.ok(notices[0].includes(`eventsource-parser ${version}`));
      assert.ok(notices[0].includes(`Fixture notice ${version}`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled entities uses the exact-version upstream license supplement", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-entities-notices-"));
  try {
    const output = await prepareNotices(root);
    const directory = join(root, "dependencies/entities");
    await mkdir(directory, { recursive: true });
    const manifest = join(directory, "package.json");
    await writeFile(
      manifest,
      JSON.stringify({ name: "@nodable/entities", version: "3.1.0" }),
    );
    await writeFile(join(directory, "index.js"), "export {};\n");
    await writeFile(
      join(root, "graph.json"),
      JSON.stringify({
        inputs: { "dependencies/entities/index.js": { bytes: 0, imports: [] } },
      }),
    );
    const options = { repository: root, output, metafile: "graph.json" };
    await writeCliNotices(options);
    const notices = await readFile(join(output, "THIRD_PARTY_NOTICES"), "utf8");
    const upstream = await readFile(
      join(
        repository,
        "apps/tui/npm/licenses/nodable-val-parsers-v3.1.0-LICENSE",
      ),
      "utf8",
    );
    assert.ok(
      notices.includes(`@nodable/entities 3.1.0\n\n${upstream.trim()}`),
    );

    // A future dependency update must supply its own reviewed provenance.
    await writeFile(
      manifest,
      JSON.stringify({ name: "@nodable/entities", version: "3.1.1" }),
    );
    await assert.rejects(
      writeCliNotices(options),
      /No upstream license text found for: @nodable\/entities/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
