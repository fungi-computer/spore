import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { hasOnboarding, runOnboarding } from "../src/onboarding.js";
import { linearAuthInteraction } from "@fungi.computer/truffle/auth";
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

/** Answer each prompt once it has drawn, the way a person would. */
function keys(answers: readonly string[]) {
  const input = new PassThrough();
  let output = "";
  let next = 0;
  const prompts = [/How should Shiitake reach a model\?/u];
  return {
    input,
    output: () => output,
    write(text: string) {
      output += text;
      const answer = answers[next];
      const prompt = prompts[next];
      if (answer !== undefined && prompt?.test(output)) {
        next += 1;
        setTimeout(() => input.write(answer), 10);
      }
    },
  };
}

test("first run asks one question, signs in once, and opens fungi by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-onboarding-"));
  const path = join(root, "onboarding.json");
  const doors: string[] = [];
  const terminal = keys(["\r"]);
  try {
    const start = await runOnboarding({
      interactive: true,
      yes: false,
      path,
      input: terminal.input,
      write: (text) => {
        terminal.write(text);
      },
      signIn: (door) => {
        doors.push(door);
        return Promise.resolve();
      },
    });
    const screen = stripVTControlCharacters(terminal.output());
    if (process.env.TUI_UX_CAPTURE_DIR)
      await writeFile(
        join(process.env.TUI_UX_CAPTURE_DIR, "08-onboarding.txt"),
        screen,
      );
    expect(start).toBe(true);
    expect(doors).toEqual(["fungi"]);
    expect(screen).toContain("Sign in to Fungi (recommended)");
    expect(screen).toContain("Use my Claude or ChatGPT subscription");
    expect(screen).toContain("Use an API key");
    expect(screen).toContain("Skip for now");
    expect(screen).not.toContain("Team MCP");
    expect(screen).not.toContain("Open Fungi now?");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      door: "hosted",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skipping sign-in never starts a login", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-onboarding-"));
  const path = join(root, "onboarding.json");
  const terminal = keys(["\u001B[B\u001B[B\u001B[B\r"]);
  try {
    const start = await runOnboarding({
      interactive: true,
      yes: false,
      path,
      input: terminal.input,
      write: (text) => {
        terminal.write(text);
      },
      signIn: () => Promise.reject(new Error("Skip attempted a login")),
    });
    expect(start).toBe(true);
    expect(stripVTControlCharacters(terminal.output())).not.toContain(
      "Open Fungi now?",
    );
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
    /needs an interactive terminal/u,
  );
});

test("doctor reports actual failed checks without exposing credentials or blocking later checks", async () => {
  let output = "";
  const result = await runDoctor({
    localServiceStatus: () => Promise.resolve(undefined),
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
  expect(output).toContain(
    "FAIL sign-in: Not signed in. Run fungi login --provider fungi",
  );
  expect(output).toContain(
    "FAIL Fungi models: Sign in to Fungi with fungi login --provider fungi",
  );
  expect(output).not.toContain("Use your own Claude or ChatGPT subscription");
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
    localServiceStatus: () => Promise.resolve(undefined),
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
  expect(output).toContain(
    "FAIL Fungi models: Sign in to Fungi with fungi login --provider fungi",
  );
  expect(output).not.toContain("Use your own Claude or ChatGPT subscription");
});

test("doctor reports saved Fungi sign-in and a ready model without credential values", async () => {
  let output = "";
  const passed = await runDoctor({
    localServiceStatus: () =>
      Promise.resolve({
        protocol: 4,
        version: "source",
        serviceId: "owned-onboarding-fixture",
        pid: 1,
        baseUrl: "http://127.0.0.1:12345",
        diagnostics: { state: "active" },
      }),
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
