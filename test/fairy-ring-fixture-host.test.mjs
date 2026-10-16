import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { test } from "bun:test";
import host from "./fixtures/fairy-ring-extension/host.mjs";

test("the frozen Fairy Ring fixture declares its actual host and dashboard entrypoints", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("./fixtures/fairy-ring-extension/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.exports["./host"], "./host.mjs");
  assert.ok(host, "the declared host export loads");
  assert.deepEqual(manifest.fungi.terminals[0].command, [
    "./bin/fairy-ring-tui",
  ]);
});
