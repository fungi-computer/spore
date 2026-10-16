import { expect, test } from "bun:test";
import { runFungiCli } from "../src/cli.js";
import { helpFor } from "../src/cli-help.js";
import { runDoctor } from "../src/doctor.js";

const commands = [
  "new",
  "resume",
  "sessions",
  "run",
  "acp",
  "login",
  "logout",
  "status",
  "account",
  "doctor",
  "computers",
  "computer",
  "mcp",
  "extension",
  "stop",
  "update",
  "serve",
  "git-credential",
  "help",
];

test("every dispatched command has identical help through both spellings and fits 80 columns", async () => {
  for (const command of commands) {
    const texts: string[] = [];
    for (const args of [
      [command, "--help"],
      ["help", command],
    ]) {
      let text = "";
      await runFungiCli(args, {
        stdout: {
          write(chunk) {
            text += String(chunk);
            return true;
          },
        },
      });
      texts.push(text);
    }
    expect(texts[0], command).toBe(texts[1]);
    for (const line of helpFor(command).split("\n")) {
      expect(line.length, `${command}: ${line}`).toBeLessThanOrEqual(80);
    }
  }
  expect(helpFor(undefined)).not.toMatch(/serve|git-credential|from-source/u);
  expect(helpFor("new")).not.toContain("--fungi-mcp");
  expect(helpFor("sessions")).toContain("schemaVersion 2");
});

test("help descriptions share column 33", () => {
  for (const command of [
    undefined,
    "new",
    "resume",
    "run",
    "login",
    "logout",
    "status",
    "serve",
    "computer",
  ]) {
    for (const line of helpFor(command).split("\n")) {
      const row = /^\s{2,6}\S.*?\s{2,}(\S.*)$/u.exec(line);
      if (row?.[1] !== undefined) expect(line.indexOf(row[1]), line).toBe(33);
    }
  }
});

test("doctor prints its title once", async () => {
  let text = "";
  await runDoctor({
    models: {
      getProviders: () => [],
      checkAuth: () => Promise.resolve(undefined),
      login: () => Promise.reject(new Error("unused")),
      logout: () => Promise.resolve(),
    },
    fungiAccount: () => Promise.resolve(undefined),
    version: "test",
    connect: () => Promise.resolve(false),
    write: (chunk) => {
      text += chunk;
    },
  });
  expect(
    text.split("\n").filter((line) => line === "fungi doctor"),
  ).toHaveLength(1);
});
