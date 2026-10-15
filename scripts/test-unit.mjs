import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The child owns HOME for the entire suite, including module imports and teardown.
const home = mkdtempSync(join(tmpdir(), "fungi-tui-unit-home-"));
try {
  const args = process.argv.slice(2);
  const child = spawnSync(
    "bun",
    ["test", ...(args.length === 0 ? ["./test"] : args)],
    {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      env: { ...process.env, HOME: home },
      stdio: "inherit",
    },
  );
  if (child.error !== undefined)
    throw new Error("Could not start the isolated TUI unit suite", {
      cause: child.error,
    });
  if (child.status === null)
    throw new Error(
      `The isolated TUI unit suite ended with signal ${child.signal}`,
    );
  process.exitCode = child.status;
} finally {
  rmSync(home, { recursive: true, force: true });
}
