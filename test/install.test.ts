import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../../../install.sh", import.meta.url).pathname;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("installer maps all four release platforms and rejects unsupported systems", () => {
  for (const [os, arch, expected] of [
    ["Linux", "x86_64", "linux-x64"],
    ["Linux", "aarch64", "linux-arm64"],
    ["Darwin", "x86_64", "darwin-x64"],
    ["Darwin", "arm64", "darwin-arm64"],
  ] as const) {
    const result = Bun.spawnSync(["sh", installer, "--platform", os, arch]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(expected);
  }
  for (const args of [
    ["Windows", "x86_64"],
    ["Linux", "riscv64"],
  ] as const) {
    const result = Bun.spawnSync(["sh", installer, "--platform", ...args]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Unsupported");
  }
});

test("installer's built-in default release URL is a valid, overridable https URL", () => {
  const byDefault = Bun.spawnSync(["sh", installer, "--release-url"], {
    env: { PATH: process.env.PATH },
  });
  expect(byDefault.exitCode).toBe(0);
  const defaultUrl = byDefault.stdout.toString().trim();
  const parsed = new URL(defaultUrl);
  expect(parsed.protocol).toBe("https:");
  expect(parsed.hostname).toBe("fungi.computer");

  const overridden = Bun.spawnSync(["sh", installer, "--release-url"], {
    env: {
      PATH: process.env.PATH,
      FUNGI_RELEASE_URL: "https://mirror.example.test/releases",
    },
  });
  expect(overridden.exitCode).toBe(0);
  expect(overridden.stdout.toString().trim()).toBe(
    "https://mirror.example.test/releases",
  );
});

test("installer verifies real downloads and preserves the binary on checksum failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-installer-"));
  directories.push(root);
  const binary = "#!/bin/sh\nprintf 'fixture fungi\\n'\n";
  const digest = createHash("sha256").update(binary).digest("hex");
  let checksum = digest;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new Response(
        new URL(request.url).pathname.endsWith(".sha256")
          ? `${checksum}  fungi\n`
          : binary,
      );
    },
  });
  const run = async () => {
    const child = Bun.spawn(["sh", installer], {
      env: {
        ...process.env,
        FUNGI_INSTALL: root,
        FUNGI_RELEASE_URL: server.url.href,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output, errors };
  };
  try {
    const success = await run();
    expect(success.exitCode).toBe(0);
    expect(success.output).toContain("Checksum verified");
    expect(await readFile(join(root, "bin/fungi"), "utf8")).toBe(binary);
    await writeFile(join(root, "bin/fungi"), "previous installation");
    for (const invalid of ["0".repeat(64), "invalid", ""]) {
      checksum = invalid;
      const result = await run();
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(join(root, "bin/fungi"), "utf8")).toBe(
        "previous installation",
      );
    }
  } finally {
    await server.stop(true);
  }
});
