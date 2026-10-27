import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import {
  createPrivateCredentialStore,
  resolveDefaultCredentialPath,
} from "@fungi.computer/truffle";
import { runFungiCli } from "../src/cli.js";

test("fungi logout uses the shared offline account owner without a Local lifecycle request", async () => {
  assert.match(homedir(), /fungi-tui-unit-home-/u);
  const home = await mkdtemp(join(tmpdir(), "fungi-cli-offline-logout-"));
  // A loopback issuer with unavailable OAuth metadata keeps revocation
  // unconfirmed. It is not a Local service or a live mesh link.
  const issuer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 404 }),
  });
  const credential = {
    type: "oauth",
    // Generated with jose SignJWT and a synthetic HS256 key; routing claims
    // only, never an authorization token for a real account.
    access:
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LWNsaS1sb2dvdXQiLCJodHRwczovL2Z1bmdpLmNvbXB1dGVyL29hdXRoL2xvZ2luIjoibG9naW4tY2xpLWxvZ291dCJ9.7OJZ-dzs_ObiBksDQqihd5nfgt6iyRnI3mjWycLZgPQ", //gitleaks:allow
    refresh: "fixture-cli-logout-refresh",
    expires: Date.now() + 60_000,
    issuer: issuer.url.origin,
    clientId: "fixture-cli-logout-client",
  } satisfies OAuthCredential;
  const other = {
    type: "api_key",
    key: "fixture-unrelated-secret",
  } satisfies Credential;
  const store = createPrivateCredentialStore(
    resolveDefaultCredentialPath(home),
  );
  let output = "";
  const io = {
    stdout: {
      write: (chunk: string) => {
        output += chunk;
        return true;
      },
    },
  };
  try {
    await store.modify("fungi", () => Promise.resolve(credential));
    await store.modify("anthropic", () => Promise.resolve(other));
    assert.deepEqual(await store.read("fungi"), credential);
    const serviceRecord = join(home, ".fungi", "service", "service.json");
    await assert.rejects(stat(serviceRecord), { code: "ENOENT" });

    await runFungiCli(
      ["logout", "--provider", "fungi"],
      io,
      {
        createServiceManager: () => {
          assert.fail(
            "Offline Fungi logout must not request Local lifecycle control",
          );
        },
      },
      home,
    );

    assert.equal(await store.read("fungi"), undefined);
    assert.deepEqual(await store.read("anthropic"), other);
    assert.equal(
      output,
      "Signed out here. Couldn't confirm with Fungi; you can revoke this login under Connected logins.\n",
    );
    for (const secret of [credential.access, credential.refresh, other.key])
      assert.equal(output.includes(secret), false);
    await assert.rejects(stat(serviceRecord), { code: "ENOENT" });

    output = "";
    await runFungiCli(["account", "--json"], io, {}, home);
    assert.deepEqual(JSON.parse(output), { schemaVersion: 1, signedIn: false });
  } finally {
    await issuer.stop(true);
    await rm(home, { recursive: true });
  }
}, 15_000);
