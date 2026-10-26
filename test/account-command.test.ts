import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { runFungiCli } from "../src/cli.js";
import { createPrivateCredentialStore } from "@fungi.computer/truffle";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { createIsolatedCliEnvironment } from "./cli-test-isolation.js";

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
  const isolated = await createIsolatedCliEnvironment();
  try {
    for (const args of [["account"], ["account", "teams"]]) {
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("../src/cli.tsx", import.meta.url).pathname,
          ...args,
        ],
        {
          env: isolated.env,
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
  } finally {
    await isolated.cleanup();
  }
}, 15000);

test("credential activation CLI uses stdin, fails closed on conflict and never outputs credentials", async () => {
  const isolated = await createIsolatedCliEnvironment();
  const { home } = isolated;
  const first = {
    type: "oauth",
    access: "fake-cli-secret-first",
    refresh: "fake-cli-secret-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "fake-account",
  } satisfies OAuthCredential;
  const next = { ...first, access: "fake-cli-secret-next" };
  async function activate(
    expected: OAuthCredential | null,
    credential: OAuthCredential,
  ) {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/cli.tsx", import.meta.url).pathname,
        "account",
        "use-credential",
        "--provider",
        "anthropic",
        "--from-file",
        "-",
      ],
      {
        env: isolated.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await child.stdin.write(JSON.stringify({ expected, credential }));
    await child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(`${stdout}${stderr}`.includes("fake-cli-secret"), false);
    return { stdout, stderr, code };
  }
  try {
    assert.equal((await activate(null, first)).code, 0);
    assert.equal((await activate(first, next)).code, 0);
    const conflict = await activate(first, first);
    assert.equal(conflict.code, 1);
    assert.deepEqual(JSON.parse(conflict.stdout), {
      ok: false,
      error: { category: "conflict" },
    });
    const saved = await createPrivateCredentialStore(
      join(home, ".config/fungi/credentials.json"),
    ).read("anthropic");
    assert.equal(saved?.type === "oauth" && saved.access === next.access, true);
  } finally {
    await isolated.cleanup();
  }
}, 15000);
