import { expect, test } from "bun:test";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

test("CLI internal-service branch persists its real version and SIGTERM lifecycle in private files under umask 022 (not packed-release proof)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sp-log-"));
  const home = join(root, "home");
  const directory = join(home, ".fungi", "service");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
  // Inherit the mask synchronously; never leave it changed across an await.
  const previousMask =
    process.platform === "win32" ? undefined : process.umask(0o022);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../src/cli.tsx", import.meta.url)),
        "--internal-service",
        directory,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: join(home, "tmp"),
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
        },
        stdio: "ignore",
      },
    );
  } finally {
    if (previousMask !== undefined) process.umask(previousMask);
  }
  const exited = once(child, "exit");
  const pid = z.number().int().positive().parse(child.pid);
  try {
    const manager = createPrivateLocalServiceManager({ directory });
    let status = await manager.status();
    for (let attempt = 0; status === undefined && attempt < 100; attempt++) {
      await delay(100);
      status = await manager.status();
    }
    assert.ok(status, "Owned CLI fixture did not register");
    expect(status.pid).toBe(pid);
    const version = status.version;
    child.kill("SIGTERM");
    await exited;
    if (process.platform !== "win32")
      expect((await stat(join(directory, "service.jsonl"))).mode & 0o777).toBe(
        0o600,
      );
    const lifecycleSchema = z.object({
      source: z.literal("local-service"),
      event: z.string(),
      pid: z.number().int(),
      version: z.string(),
      reason: z
        .enum(["SIGINT", "SIGTERM", "startup-failure", "runtime-failure"])
        .optional(),
    });
    const records = [];
    const lines = createInterface({
      input: createReadStream(join(directory, "service.jsonl")),
    });
    try {
      for await (const line of lines)
        records.push(lifecycleSchema.parse(JSON.parse(line)));
    } finally {
      lines.close();
    }
    expect(records.map((record) => record.event)).toEqual([
      "starting",
      "ready",
      "stopping",
      "stopped",
    ]);
    expect(
      records.every(
        (record) => record.pid === pid && record.version === version,
      ),
    ).toBe(true);
    expect(records.at(-1)?.reason).toBe("SIGTERM");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
