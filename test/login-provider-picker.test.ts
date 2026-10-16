import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { createPrivateModels } from "@fungi.computer/truffle";
import type { LocalAuthModels } from "@fungi.computer/truffle/auth";
import { runFungiCli, type TuiAuthCall } from "../src/cli.js";

function models(): LocalAuthModels {
  return {
    getProviders: () => createPrivateModels().getProviders(),
    checkAuth: (id) =>
      Promise.resolve(id === "openai" ? { type: "oauth" } : undefined),
    login: () => Promise.reject(new Error("Unexpected provider login")),
    logout: () => Promise.reject(new Error("Unexpected logout")),
  };
}

function terminal(inputText: string) {
  const input = new PassThrough();
  const signals = new EventEmitter();
  let initialFrame = "";
  const stdout = {
    write(chunk: string | Uint8Array) {
      const text = stripVTControlCharacters(chunk.toString());
      if (text.includes("More providers") && !initialFrame) {
        initialFrame = text;
        queueMicrotask(() => input.write(inputText));
      }
      return true;
    },
  };
  return { input, signals, stdout, initialFrame: () => initialFrame };
}

test("onboarding searches the shared provider groups and passes the selected ID to Local", async () => {
  const t = terminal("openrouter\r");
  const authModels = models();
  let auth: TuiAuthCall | undefined;
  await runFungiCli(
    ["login", "--auth-type", "api_key"],
    {
      interactive: true,
      stdin: t.input,
      stdout: t.stdout,
      signals: t.signals,
      authModels,
    },
    {
      runAuth: (_command, options) => {
        auth = options;
        return Promise.resolve();
      },
      createRenderer: () =>
        Promise.reject(new Error("Onboarding must stay in Clack")),
    },
  );
  const frame = t.initialFrame();
  expect(frame).toContain("SIGNED IN\n│  ▶ OpenAI  API key or Subscription");
  // An API key never means the Fungi account.
  expect(frame).not.toContain("Fungi account");
  expect(frame).toContain("Which provider's API key?");
  expect(frame).toContain("More providers (");
  expect(frame).not.toContain("Amazon Bedrock");
  expect(frame).not.toContain("(openai)");
  expect(auth?.providerId).toBe("openrouter");
  expect(auth?.authType).toBe("api_key");
  expect(auth?.models).toBe(authModels);
  expect(t.signals.listenerCount("SIGINT")).toBe(0);
  expect(t.signals.listenerCount("SIGTERM")).toBe(0);
});

test("cancelling the onboarding provider step never starts login", async () => {
  const t = terminal("\u0003");
  await assert.rejects(
    runFungiCli(
      ["login", "--auth-type", "oauth"],
      {
        interactive: true,
        stdin: t.input,
        stdout: t.stdout,
        signals: t.signals,
        authModels: models(),
      },
      {
        runAuth: () =>
          Promise.reject(new Error("Cancelled picker must not dispatch")),
      },
    ),
    /Login cancelled/u,
  );
  expect(t.signals.listenerCount("SIGINT")).toBe(0);
  expect(t.signals.listenerCount("SIGTERM")).toBe(0);
});

test("expanded providers use the actual terminal height", async () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 36 });
  let expanding = false;
  let expanded = "";
  output.on("data", (chunk: Buffer) => {
    const text = stripVTControlCharacters(chunk.toString());
    if (!expanding && text.includes("More providers")) {
      expanding = true;
      queueMicrotask(() => input.write("\u001b[B".repeat(5) + "\r"));
    } else if (text.includes("MORE PROVIDERS")) {
      expanded = text;
      queueMicrotask(() => input.write("\u0003"));
    }
  });
  await assert.rejects(
    runFungiCli(["login", "--auth-type", "api_key"], {
      interactive: true,
      stdin: input,
      stdout: output,
      authModels: models(),
    }),
    /Login cancelled/u,
  );
  expect(expanded).toContain("Amazon Bedrock");
  expect(expanded).toContain("Cerebras");
  expect(expanded).toContain("Cloudflare Workers AI");
});
