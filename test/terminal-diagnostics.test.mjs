import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { test } from "bun:test";
import { createIsolatedCliEnvironment } from "./cli-test-isolation.ts";

for (const scenario of ["preparation", "attachment"])
  test(`extension ${scenario} failure stays in-frame, redacted in the log and off the raw terminal`, async () => {
    const isolated = await createIsolatedCliEnvironment();
    const home = isolated.home;
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const output = [];
    const drained = Promise.withResolvers();
    let child;
    try {
      // Bun gives this fixture its own TTY. The memory renderer
      // captures all legitimate frame output, leaving only rogue writes on it.
      child = spawn(
        [process.execPath, "./test/terminal-diagnostics.fixture.mjs"],
        {
          cwd: packageRoot,
          env: isolated.environment({
            HERDR_ENV: "0",
            TUI_DIAGNOSTICS_SCENARIO: scenario,
            PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          }),
          terminal: {
            data: (_terminal, bytes) => output.push(Buffer.from(bytes)),
            exit: () => drained.resolve(),
          },
        },
      );
      const [status] = await Promise.all([child.exited, drained.promise]);
      const rawOutput = Buffer.concat(output).toString("utf8");
      assert.equal(status, 0, rawOutput);
      assert.equal(
        rawOutput,
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
      child?.terminal.close();
      await isolated.cleanup();
    }
  }, 10_000);
