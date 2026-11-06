import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { createIsolatedCliEnvironment } from "./cli-test-isolation.ts";

const bun = fileURLToPath(
  new URL("../node_modules/bun/bin/bun.exe", import.meta.url),
);
const proof = fileURLToPath(
  new URL("./installed-cli.proof.mjs", import.meta.url),
);

// A native signal stall cannot run a JavaScript deadline in the proof process.
// Node owns the timeout and SIGKILL outside Bun; the ordinary scope owns descendants.
async function runProof(env, timeout) {
  const isolated = await createIsolatedCliEnvironment();
  try {
    const child = spawnSync(bun, [proof], {
      env: isolated.environment(env),
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (child.error?.code === "ETIMEDOUT")
      throw new Error(
        `Installed CLI proof exceeded ${timeout}ms; killed with SIGKILL. Last progress:\n${child.stderr}`,
        { cause: child.error },
      );
    assert.ifError(child.error);
    return child;
  } finally {
    await isolated.cleanup();
  }
}

test("installed CLI completes its service, recovery, files and hook proof", async () => {
  const child = await runProof({}, 120_000);
  assert.equal(child.status, 0, `signal=${child.signal}\n${child.stderr}`);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ownerClosed, true);
  assert.deepEqual(result.homeDirectTools, {
    read: "passed",
    apply_patch: "passed",
  });
});

test("installed CLI startup refusal exits without signalling a stopped service", async () => {
  const root = mkdtempSync(join(tmpdir(), "fungi-installed-refusal-"));
  try {
    // A real invalid runtime directory fails before the service installs SIGTERM.
    const runtime = join(root, "not-a-directory");
    writeFileSync(runtime, "fixture");
    const child = await runProof({ XDG_RUNTIME_DIR: runtime }, 10_000);
    assert.equal(child.status, 1, `signal=${child.signal}\n${child.stderr}`);
    assert.match(
      child.stderr,
      /Installed CLI proof: collect Local service shutdown/u,
    );
    assert.match(child.stderr, /XDG_RUNTIME_DIR must be a private directory/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
