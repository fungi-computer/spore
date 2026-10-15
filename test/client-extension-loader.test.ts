import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import { loadInstalledClientExtension } from "../src/installed-client-extension.js";

void test("installed extension loading validates the entry without attaching it", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-extension-loader-"));
  try {
    await writeFile(
      join(root, "entry.mjs"),
      `export default {
      protocol: "shiitake.client/v1", id: "fixture",
      attach() { throw new Error("loading must not attach"); }
    };`,
    );
    const definition = await Effect.runPromise(
      loadInstalledClientExtension("./entry.mjs", root),
    );
    assert.equal(definition?.id, "fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("missing optional package is absent; explicit missing package is an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-extension-missing-"));
  try {
    assert.equal(
      await Effect.runPromise(
        loadInstalledClientExtension("./missing.mjs", root, true),
      ),
      undefined,
    );
    await assert.rejects(
      Effect.runPromise(loadInstalledClientExtension("./missing.mjs", root)),
      /Client extension unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("optional does not hide a malformed installed definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-extension-invalid-"));
  try {
    await writeFile(
      join(root, "entry.mjs"),
      'export default { manifest: { id: "invalid" } };',
    );
    await assert.rejects(
      Effect.runPromise(
        loadInstalledClientExtension("./entry.mjs", root, true),
      ),
      /Client extension unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("V1 client protocol and valid identity are required for a client entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-extension-protocol-"));
  try {
    for (const [name, protocol, id] of [
      ["old", "shiitake.client/v0", "fixture"],
      ["other", "shiitake.client/v1", "Invalid Identity"],
    ] as const) {
      await writeFile(
        join(root, `${name}.mjs`),
        `export default {
          protocol: "${protocol}", id: "${id}",
          attach() { throw new Error("must not attach"); }
        };`,
      );
      await assert.rejects(
        Effect.runPromise(loadInstalledClientExtension(`./${name}.mjs`, root)),
        /Client extension unavailable/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
