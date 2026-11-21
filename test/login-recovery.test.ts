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

test("fungi login --device shows the page and code, then signs in to the Hub", async () => {
  let output = "";
  const endpoints: string[] = [];
  await runFungiCli(
    ["login", "--device", "--hub", "https://custom.test"],
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
      signInFungi: () => Promise.reject(new Error("browser login used")),
      signInFungiDevice: (endpoint, options) => {
        endpoints.push(endpoint);
        options.showDeviceCode({
          userCode: "BCDFGHJK",
          verificationUri: "https://custom.test/device",
          verificationUriComplete:
            "https://custom.test/device?user_code=BCDFGHJK",
          expiresInSeconds: 600,
        });
        return Promise.resolve();
      },
    },
  );
  expect(endpoints).toEqual(["https://custom.test/"]);
  const shown = stripVTControlCharacters(output);
  expect(shown).toContain("https://custom.test/device");
  expect(shown).toContain("BCDFGHJK");
  expect(shown).toContain("expires in 10 minutes");
  expect(shown).toContain("Fungi login complete");
});

test("a failed device login names its own retry", async () => {
  const failure = new Error("Device sign-in was denied in the browser.");
  let output = "";
  await assert.rejects(
    runFungiCli(
      ["login", "--device"],
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
        signInFungiDevice: () => Promise.reject(failure),
      },
    ),
    (cause) => cause === failure,
  );
  expect(output).toContain("To try again, run fungi login --device.");
});

for (const args of [
  ["status", "--device"],
  ["login", "--device", "--provider", "openai"],
  ["login", "--device", "--method", "browser"],
]) {
  test(`refuses ${args.join(" ")}`, async () => {
    await assert.rejects(
      runFungiCli(
        args,
        { interactive: false },
        {
          readFungiStatus: () => Promise.resolve(undefined),
          signInFungiDevice: () => Promise.reject(new Error("must not run")),
        },
      ),
      /--device/u,
    );
  });
}
