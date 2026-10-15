import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { runFungiCli } from "../src/cli.js";

test("update help explains integration build and copied-store proof without starting them", async () => {
  let output = "";
  await runFungiCli(["update", "--help"], {
    stdout: {
      write: (chunk) => {
        output += String(chunk);
        return true;
      },
    },
  });
  expect(output).toContain("fungi update [source-checkout]");
  expect(output).toContain("integration/parallel-work-tracking");
  expect(output).toContain("copy");
  expect(output).toContain("rollback");
});

test("update refuses extra arguments before building or changing the launcher", async () => {
  await assert.rejects(
    runFungiCli(["update", "one", "two"], { interactive: false }),
    /fungi update accepts at most one source checkout/,
  );
});
