import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasOnboarding, runOnboarding } from "../src/onboarding.js";
import { linearAuthInteraction } from "@fungi.computer/local/auth";
import { runDoctor } from "../src/doctor.js";

test("a pipe skips every setup step without persisting consent; --yes saves local-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-onboarding-"));
  const path = join(root, "onboarding.json");
  let output = "";
  const unexpected = () =>
    Promise.reject(new Error("Non-interactive onboarding attempted login"));
  try {
    expect(await hasOnboarding(path)).toBe(false);
    expect(
      await runOnboarding({
        interactive: false,
        yes: false,
        path,
        write: (text) => {
          output += text;
        },
        login: unexpected,
        signIn: unexpected,
      }),
    ).toBe(false);
    expect(await hasOnboarding(path)).toBe(false);
    expect(output).toContain("fungi doctor");
    expect(
      await runOnboarding({
        interactive: true,
        yes: true,
        path,
        write: (text) => {
          output += text;
        },
        login: unexpected,
        signIn: unexpected,
      }),
    ).toBe(false);
    expect(await hasOnboarding(path)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      door: "later",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-interactive login rejects credential prompts instead of consuming stdin", async () => {
  await assert.rejects(
    linearAuthInteraction(false).prompt({ type: "secret", message: "API key" }),
    /needs a terminal/u,
  );
});

test("doctor reports actual failed checks without exposing credentials or blocking later checks", async () => {
  let output = "";
  const result = await runDoctor({
    models: {
      getProviders: () => [],
      checkAuth: () => Promise.resolve(undefined),
      login: () => Promise.reject(new Error("unused")),
      logout: () => Promise.resolve(),
    },
    fungiAccount: () => Promise.resolve(undefined),
    version: "0.1.0",
    connect: () => Promise.resolve(false),
    write: (text) => {
      output += text;
    },
  });
  expect(result).toBe(false);
  expect(output).toContain("FAIL sign-in: Not signed in.");
  expect(output).toContain(`Platform: ${process.platform} ${process.arch}`);
  expect(output).toContain("glibc:");
  expect(output).toContain("FAIL Fungi models");
  expect(output).toContain("FAIL connectivity");
  expect(output).toContain("PASS version: 0.1.0");
});

test("doctor checks Fungi readiness rather than accepting another provider's login", async () => {
  let output = "";
  const checked: string[] = [];
  const passed = await runDoctor({
    models: {
      getProviders: () => [],
      checkAuth: (provider) => {
        checked.push(provider);
        return Promise.resolve(
          provider === "fungi" ? undefined : { type: "oauth" },
        );
      },
      login: () => Promise.reject(new Error("unused")),
      logout: () => Promise.resolve(),
    },
    fungiAccount: () =>
      Promise.resolve({
        issuer: "https://hub.test",
        accessExpiresAt: new Date(0),
        team: { teamId: "team-1", name: "Garden", handle: "garden" },
      }),
    version: "0.1.0",
    connect: () => Promise.resolve(true),
    write: (text) => {
      output += text;
    },
  });
  expect(passed).toBe(false);
  expect(checked).toEqual(["fungi"]);
  expect(output).toContain("PASS sign-in: Saved Fungi login · Garden");
  expect(output).toContain("FAIL Fungi models");
  expect(output).toContain("Sign in to Fungi");
});

test("doctor reports saved Fungi sign-in and a ready model without credential values", async () => {
  let output = "";
  const passed = await runDoctor({
    models: {
      getProviders: () => [],
      checkAuth: () => Promise.resolve({ type: "oauth" }),
      login: () => Promise.reject(new Error("unused")),
      logout: () => Promise.resolve(),
    },
    fungiAccount: () =>
      Promise.resolve({
        issuer: "https://hub.test",
        accessExpiresAt: new Date(Date.now() + 60000),
        team: { teamId: "team-1", name: "Garden", handle: "garden" },
      }),
    version: "0.0.1",
    connect: () => Promise.resolve(true),
    write: (text) => {
      output += text;
    },
  });
  expect(passed).toBe(true);
  expect(output).toContain("PASS sign-in: Saved Fungi login · Garden");
  expect(output).toContain("PASS Fungi models: selected Team ready");
  expect(output).toContain("PASS version: 0.0.1 (installed)");
  expect(output).not.toContain("https://hub.test");
  expect(output).not.toContain("team-1");
});
