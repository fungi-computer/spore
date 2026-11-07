import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "bun:test";
import { runFungiCli } from "../src/cli.js";

for (const [label, args, recovery] of [
  [
    "model provider",
    ["--provider", "openai", "--auth-type", "oauth"],
    "To try again, run fungi login.",
  ],
  [
    "Fungi account",
    ["--provider", "fungi"],
    "To try again, run fungi login --provider fungi.",
  ],
  [
    "custom Hub",
    ["--provider", "fungi", "--hub", "https://custom.test"],
    "To try again, rerun fungi login with the same --hub option.",
  ],
  [
    "Team MCP endpoint",
    ["--fungi-mcp", "https://custom.test/api/teams/team-1/mcp"],
    "To try again, rerun fungi login with the same --fungi-mcp option.",
  ],
] as const) {
  for (const message of [
    "Login cancelled.",
    "Provider could not be reached.",
  ]) {
    test(`${label} login preserves ${message} and its retry destination`, async () => {
      const failure = new Error(message);
      let output = "";
      await assert.rejects(
        runFungiCli(
          ["login", ...args],
          {
            interactive: false,
            stdout: {
              write: (chunk) => {
                output += String(chunk);
                return true;
              },
            },
          },
          {
            readFungiStatus: () => Promise.resolve(undefined),
            runAuth: () => Promise.reject(failure),
            signInFungi: () => Promise.reject(failure),
          },
        ),
        (cause) => cause === failure,
      );
      expect(output).toContain(recovery);
      expect(output).not.toContain("complete");
    });
  }
}

for (const provider of ["openai", "fungi"]) {
  test(`successful ${provider} login does not print failure recovery`, async () => {
    let output = "";
    await runFungiCli(
      ["login", "--provider", provider],
      {
        interactive: false,
        stdout: {
          write: (chunk) => {
            output += String(chunk);
            return true;
          },
        },
      },
      {
        readFungiStatus: () => Promise.resolve(undefined),
        runAuth: () => Promise.resolve(),
        signInFungi: () => Promise.resolve(),
      },
    );
    expect(output).not.toContain("To try again");
    if (provider === "fungi") expect(output).toContain("Fungi login complete");
  });
}

test("provider logout failures do not suggest logging in", async () => {
  const failure = new Error("Could not clear credentials.");
  let output = "";
  await assert.rejects(
    runFungiCli(
      ["logout", "--provider", "openai"],
      {
        interactive: false,
        stdout: {
          write: (chunk) => {
            output += String(chunk);
            return true;
          },
        },
      },
      { runAuth: () => Promise.reject(failure) },
    ),
    (cause) => cause === failure,
  );
  expect(output).not.toContain("To try again");
});

test("cancelling the Team chooser after browser sign-in shows Fungi retry guidance", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  let cancelled = false;
  output.on("data", (chunk: Buffer) => {
    shown += stripVTControlCharacters(chunk.toString());
    if (!cancelled && shown.includes("Which Team pays for Fungi models?")) {
      cancelled = true;
      queueMicrotask(() => input.write("\u0003"));
    }
  });
  await assert.rejects(
    runFungiCli(
      ["login", "--provider", "fungi"],
      { interactive: true, stdin: input, stdout: output },
      {
        readFungiStatus: () => Promise.resolve(undefined),
        signInFungi: async (_endpoint, options) => {
          assert.ok(options.chooseTeam);
          await options.chooseTeam([
            { teamId: "team-1", name: "Garden", handle: "garden" },
          ]);
        },
      },
    ),
    /Login cancelled/u,
  );
  expect(shown).toContain("To try again, run fungi login --provider fungi.");
  expect(shown).not.toContain("Fungi login complete");
});
