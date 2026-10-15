import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { spawn } from "bun";
import { test } from "bun:test";

test("unit runner isolates default diagnostics from the caller's HOME and cleans it up", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-tui-caller-home-"));
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  let child;
  try {
    const result = join(home, "result.txt");
    const fixture = join(home, "home.test.ts");
    const logger = fileURLToPath(
      new URL("../src/button/log-event.js", import.meta.url),
    );
    await writeFile(
      fixture,
      `
      import { expect, test } from "bun:test";
      import { writeFileSync } from "node:fs";
      import { homedir } from "node:os";
      import { reportFailure } from ${JSON.stringify(logger)};
      test("default diagnostic path", () => {
        expect(reportFailure("test-home", new Error("private"))).toBe(true);
        writeFileSync(${JSON.stringify(result)}, homedir());
      });
    `,
    );
    child = spawn(["node", join(root, "scripts/test-unit.mjs"), fixture], {
      cwd: root,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new globalThis.Response(child.stdout).text(),
      new globalThis.Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(status, 0, stdout + stderr);
    const isolated = await readFile(result, "utf8");
    assert.notEqual(isolated, home);
    assert.equal(dirname(isolated), tmpdir());
    assert.equal(existsSync(join(home, ".fungi")), false);
    assert.equal(existsSync(isolated), false, "the runner removes its HOME");
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await child.exited;
    }
    await rm(home, { recursive: true, force: true });
  }
});
