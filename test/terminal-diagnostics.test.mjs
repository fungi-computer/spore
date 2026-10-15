import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { test } from "bun:test";

for (const scenario of ["preparation", "attachment"])
  test(`extension ${scenario} failure stays in-frame, redacted in the log and off the raw terminal`, async () => {
    const home = await mkdtemp(join(tmpdir(), "fungi-tui-diagnostics-"));
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    let child;
    try {
      // util-linux script gives this fixture its own TTY. The memory renderer
      // captures all legitimate frame output, leaving only rogue writes on it.
      child = spawn(
        [
          "script",
          "-qefc",
          "bun ./test/terminal-diagnostics.fixture.mjs",
          "/dev/null",
        ],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            HOME: home,
            HERDR_ENV: "0",
            TUI_DIAGNOSTICS_SCENARIO: scenario,
            PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, status] = await Promise.all([
        new globalThis.Response(child.stdout).text(),
        new globalThis.Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(status, 0, stderr || stdout);
      assert.equal(
        stdout + stderr,
        "",
        "no raw TTY writes during rendering or shutdown",
      );
      const log = await readFile(
        join(home, ".fungi", "logs", "tui.jsonl"),
        "utf8",
      );
      // Formatting returns a typed source-preservation outcome, not a diagnostic.
      assert.doesNotMatch(log, /"operation":"tool-code-format"/u);
      assert.match(log, /"cause":"<redacted>"/u);
      assert.match(log, /"operation":"client-extension"/u);
      if (scenario === "attachment")
        assert.match(log, /"errorName":"ExtensionAttachError"/u);
      assert.doesNotMatch(
        log,
        /extension (preparation|attachment|live callback|cleanup) failed/iu,
      );
    } finally {
      if (child?.exitCode === null) {
        child.kill();
        await child.exited;
      }
      await rm(home, { recursive: true, force: true });
    }
  }, 10_000);
