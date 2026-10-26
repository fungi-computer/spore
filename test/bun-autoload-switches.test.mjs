import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const switches = "--config=/dev/null and --no-env-file";

test("every Bun host entry disables project config and .env autoload", () => {
  // These are host process entries, not Bun's test/build/install commands or
  // the Agent's Computer process launcher.
  const entries = [
    [
      "apps/tui/scripts/fungi.cjs",
      /spawnSync\(\s*bun,\s*\["--config=\/dev\/null", "--no-env-file", cli,/u,
    ],
    [
      "apps/tui/scripts/binary-entry.ts.txt",
      /spawnSync\(join\(runtime, "native\/bin\/bun"\), \["--config=\/dev\/null", "--no-env-file", cli,/u,
    ],
    [
      "runtimes/local/src/private-local-service.ts",
      /const bunFlags =\s*options\.executable === undefined && "bun" in process\.versions\s*\? \["--config=\/dev\/null", "--no-env-file"\]\s*: \[\];[\s\S]*?spawn\(\s*options\.executable \?\? process\.execPath,\s*\[\s*\.\.\.bunFlags,\s*serviceEntry,/u,
    ],
  ];
  for (const [file, entry] of entries) {
    assert.ok(
      entry.test(readFileSync(join(root, file), "utf8")),
      `${file}: Bun host launch must include ${switches}`,
    );
  }

  const file = "apps/tui/package.json";
  const manifest = JSON.parse(readFileSync(join(root, file), "utf8"));
  assert.equal(
    manifest.scripts.start,
    "bun --config=/dev/null --no-env-file dist/cli.js",
    `${file}: Bun host start must include ${switches}`,
  );
});
