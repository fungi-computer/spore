import { build } from "bun";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the built updater's relative imports resolve for the package bundler", async () => {
  const result = await build({
    entrypoints: [fileURLToPath(new URL("../dist/update.js", import.meta.url))],
    target: "bun",
    packages: "external",
  });
  expect(result.success).toBe(true);
});
