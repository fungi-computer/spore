import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { reportFailure } from "../src/button/log-event.js";

const failureReport = z.strictObject({
  timestamp: z.iso.datetime(),
  pid: z.number().int().positive(),
  operation: z.string(),
  errorKind: z.enum(["error", "non-error"]),
  errorName: z.string().optional(),
  chain: z.array(
    z.strictObject({
      name: z.string(),
      code: z.string().optional(),
      issues: z.array(z.string()).optional(),
    }),
  ),
  cause: z.literal("<redacted>"),
});

test("failure reports persist only redacted metadata in a private log, not the terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-diagnostic-log-"));
  const path = join(directory, "logs", "tui.jsonl");
  const originalError = console.error;
  const messages: unknown[][] = [];
  console.error = (...values: unknown[]) => messages.push(values);
  try {
    const named = new Error("timed out with private-cause-marker");
    named.name = "TimeoutError";
    const unprintable = new Error("private-cause-marker");
    unprintable.name = "token=private-cause-marker";
    expect(reportFailure("session-connect-recovery", named, path)).toBe(true);
    expect(reportFailure("doctor-model-check", unprintable, path)).toBe(true);
    expect(
      reportFailure("tool-code-format", { text: "private-cause-marker" }, path),
    ).toBe(true);
    const text = await readFile(path, "utf8");
    const reports = text
      .trimEnd()
      .split("\n")
      .map((line) => failureReport.parse(JSON.parse(line)));
    expect(reports.map((report) => report.errorName)).toEqual([
      "TimeoutError",
      "Error",
      undefined,
    ]);
    expect(reports.map((report) => report.errorKind)).toEqual([
      "error",
      "error",
      "non-error",
    ]);
    expect(text).not.toContain("private-cause-marker");
    expect((await stat(join(directory, "logs"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(reports.every((report) => report.pid === process.pid)).toBe(true);
    expect(
      reports.every((report) => Date.parse(report.timestamp) <= Date.now()),
    ).toBe(true);
    expect(messages).toEqual([]);
  } finally {
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a wrapped schema failure logs its error classes and which keys the schema refused, never a value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-diagnostic-chain-"));
  const path = join(directory, "tui.jsonl");
  try {
    const refused = z.strictObject({ agents: z.array(z.strictObject({})) });
    const parsed = refused.safeParse({
      agents: [{}, { name: "Scout", "token=private-cause-marker": 1 }],
    });
    if (parsed.success) throw new Error("The fixture must be refused");
    const mount = new Error("Pane mount failed private-cause-marker", {
      cause: parsed.error,
    });
    const system = Object.assign(new Error("private-cause-marker"), {
      code: "ENOENT",
    });
    expect(reportFailure("client-row-open", mount, path)).toBe(true);
    expect(reportFailure("client-extension", system, path)).toBe(true);
    const text = await readFile(path, "utf8");
    const [wrapped, errno] = text
      .trimEnd()
      .split("\n")
      .map((line) => failureReport.parse(JSON.parse(line)));
    expect(wrapped?.chain).toEqual([
      { name: "Error" },
      {
        name: "ZodError",
        issues: ["unrecognized_keys at agents.1 [name,*]"],
      },
    ]);
    expect(errno?.chain).toEqual([{ name: "Error", code: "ENOENT" }]);
    expect(text).not.toContain("private-cause-marker");
    expect(text).not.toContain("Scout");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a token-shaped key or path segment logs as *, never as itself", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-diagnostic-token-"));
  const path = join(directory, "tui.jsonl");
  try {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const short = "sk-proj-abc123";
    const refused = z.record(z.string(), z.strictObject({}));
    const parsed = refused.safeParse({ [token]: { [short]: 1 } });
    if (parsed.success) throw new Error("The fixture must be refused");
    expect(reportFailure("client-row-open", parsed.error, path)).toBe(true);
    const text = await readFile(path, "utf8");
    const [report] = text
      .trimEnd()
      .split("\n")
      .map((line) => failureReport.parse(JSON.parse(line)));
    expect(report?.chain[0]?.issues).toEqual(["unrecognized_keys at * [*]"]);
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("sk-proj");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic logs retain one bounded rotation instead of an unbounded report queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-diagnostic-rotation-"));
  const path = join(directory, "tui.jsonl");
  try {
    const full = "x".repeat(1_048_576);
    await writeFile(path, full);
    expect(reportFailure("first", new Error("private"), path)).toBe(true);
    expect((await stat(`${path}.1`)).size).toBe(1_048_576);
    expect(
      failureReport.parse(JSON.parse((await readFile(path, "utf8")).trimEnd()))
        .operation,
    ).toBe("first");
    await writeFile(path, full);
    expect(reportFailure("second", new Error("private"), path)).toBe(true);
    expect((await stat(`${path}.1`)).size).toBe(1_048_576);
    expect((await stat(path)).size).toBeLessThan(1_048_576);
    expect(existsSync(`${path}.2`)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed diagnostic write never falls back to stderr or throws into rendering", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "fungi-diagnostic-unwritable-"),
  );
  const originalError = console.error;
  const messages: unknown[][] = [];
  console.error = (...values: unknown[]) => messages.push(values);
  try {
    // A directory is a real filesystem write refusal, including under root.
    const path = join(directory, "logs", "tui.jsonl");
    await mkdir(path, { recursive: true });
    expect(reportFailure("tool-code-format", new Error("private"), path)).toBe(
      false,
    );
    expect(messages).toEqual([]);
  } finally {
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic writes tighten existing directory, live file and rotated file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-diagnostic-modes-"));
  const logs = join(directory, "logs");
  const path = join(logs, "tui.jsonl");
  try {
    await mkdir(logs);
    await writeFile(path, "x".repeat(1_048_576));
    await writeFile(`${path}.1`, "old rotation");
    await chmod(logs, 0o755);
    await chmod(path, 0o644);
    await chmod(`${path}.1`, 0o644);
    expect(reportFailure("permissions", new Error("private"), path)).toBe(true);
    expect((await stat(logs)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
    await chmod(`${path}.1`, 0o644);
    await chmod(path, 0o644);
    expect(reportFailure("existing-rotation", new Error("private"), path)).toBe(
      true,
    );
    expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
