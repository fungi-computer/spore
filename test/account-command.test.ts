import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "bun:test";
import { runFungiCli } from "../src/cli.js";

test("fungi account --json reads the isolated home's Fungi account", async () => {
  // The unit runner owns a temporary HOME; never read a real ~/.fungi.
  assert.match(homedir(), /fungi-tui-unit-home-/u);
  let output = "";
  const io = {
    stdout: {
      write: (chunk: string) => {
        output += chunk;
        return true;
      },
    },
  };
  await runFungiCli(["account", "--json"], io);
  assert.deepEqual(JSON.parse(output), { schemaVersion: 1, signedIn: false });
  await assert.rejects(
    runFungiCli(["account", "use-team"], io),
    /Usage: fungi account/u,
  );
  await assert.rejects(
    runFungiCli(["account", "teams", "--cd", "."], io),
    /accepts only --json/u,
  );
});
