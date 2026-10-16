import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { runFungiCli } from "../src/cli.js";

test("update help explains the npm release channel without starting it", async () => {
  let output = "";
  await runFungiCli(["update", "--help"], {
    stdout: {
      write: (chunk) => {
        output += String(chunk);
        return true;
      },
    },
  });
  expect(output).toContain("Usage: fungi update\n");
  expect(output).toContain("@fungi.computer/spore on npm");
  expect(output).toContain("restores");
  expect(output).not.toContain("integration");
  expect(output).not.toContain("from-source");
});

test("update refuses extra arguments before building or changing the launcher", async () => {
  await assert.rejects(
    runFungiCli(["update", "one"], { interactive: false }),
    /fungi update does not accept positional arguments/,
  );
});
