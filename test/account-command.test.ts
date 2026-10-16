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

test("fresh account and teams commands both exit 0 and say not signed in", async () => {
  for (const args of [["account"], ["account", "teams"]]) {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/cli.tsx", import.meta.url).pathname,
        ...args,
      ],
      {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    assert.equal(await child.exited, 0);
    assert.equal(
      stdout,
      "Not signed in to Fungi. Run fungi login --provider fungi.\n",
    );
    assert.equal(stderr, "");
  }
}, 15000);
