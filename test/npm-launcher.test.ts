import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requirement =
  "Fungi CLI needs Linux x64/arm64 with glibc 2.35+, or macOS 13.5+ on Apple Silicon or Intel.\n";

async function launch(
  platform: string,
  arch: string,
  glibc: string | undefined,
  args: string[] = [],
  native = false,
  darwinRelease = "22.6.0",
  cpuModel: string | null = "Intel(R) Core(TM)",
) {
  const root = await mkdtemp(join(tmpdir(), "fungi-launcher-"));
  try {
    const dist = join(root, "dist");
    await mkdir(dist);
    await writeFile(
      join(root, "package.json"),
      '{"name":"@fungi.computer/spore","version":"0.4.0"}',
    );
    await copyFile(
      new URL("../scripts/fungi.cjs", import.meta.url),
      join(dist, "fungi.cjs"),
    );
    await writeFile(join(dist, "cli.js"), "");
    // Change only Node's OS report in the test process. The shipped launcher
    // has no environment override or bypass; its native packages are absent
    // unless this case explicitly provides an executable fixture.
    const preload = join(root, "platform.cjs");
    await writeFile(
      preload,
      `Object.defineProperty(process, 'platform', {value:${JSON.stringify(platform)}});
Object.defineProperty(process, 'arch', {value:${JSON.stringify(arch)}});
process.report.getReport = () => (${JSON.stringify({ header: { glibcVersionRuntime: glibc } })});
require("node:os").release = () => ${JSON.stringify(darwinRelease)};
require("node:os").cpus = () => ${JSON.stringify(cpuModel === null ? [] : [{ model: cpuModel }])};`,
    );
    if (native) {
      const nativeBin = join(
        root,
        `node_modules/@fungi.computer/spore-native-${platform}-${arch}/bin`,
      );
      const bunBin = join(
        root,
        `node_modules/@oven/bun-${platform}-${arch === "arm64" ? "aarch64" : "x64"}/bin`,
      );
      await mkdir(nativeBin, { recursive: true });
      await mkdir(bunBin, { recursive: true });
      await writeFile(join(nativeBin, "fungi-apply-patch"), "");
      const bun = join(bunBin, "bun");
      await writeFile(
        bun,
        '#!/usr/bin/env node\nconsole.log(process.argv.includes("--test-spore-version") ? process.env.FUNGI_SPORE_VERSION : "RUNTIME_STARTED");\n',
      );
      await chmod(bun, 0o755);
    }
    return spawnSync(
      "node",
      ["--require", preload, join(dist, "fungi.cjs"), ...args],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root },
        timeout: 10000,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [platform, arch, glibc] of [
  ["linux", "x64", "2.31"],
  ["linux", "arm64", "2.34"],
  ["linux", "x64", undefined],
  ["linux", "riscv64", "2.39"],
  ["darwin", "riscv64", undefined],
  ["win32", "x64", undefined],
] as const) {
  test(`npm launcher rejects ${platform}/${arch}/${glibc ?? "no glibc"} before native loading`, async () => {
    const child = await launch(platform, arch, glibc);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe(requirement);
  });
}

for (const arch of ["x64", "arm64"]) {
  for (const glibc of ["2.35", "2.39", "2.100", "3.0"]) {
    test(`npm launcher admits Linux ${arch} glibc ${glibc}`, async () => {
      const child = await launch("linux", arch, glibc, ["--version"], true);
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("RUNTIME_STARTED\n");
      expect(child.stderr).toBe("");
    });
  }
}

test("doctor explains an unsupported host without loading account or native code", async () => {
  const child = await launch("linux", "x64", "2.31", ["doctor"]);
  expect(child.status).toBe(1);
  expect(child.stdout).toBe(
    "Platform: linux x64\nglibc: 2.31\nSign-in: not checked on an unsupported platform\n",
  );
  expect(child.stderr).toBe(requirement);
});

test("a supported host missing its native package reports the exact reinstall command", async () => {
  const child = await launch("linux", "x64", "2.35", ["--yolo"]);
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe(
    "Fungi's native package for linux-x64 is missing or doesn't match this version. Reinstall: npm i -g @fungi.computer/spore@0.4.0\n",
  );
});

test("npm launcher passes its installed Spore version to the Bun CLI", async () => {
  const child = await launch(
    "linux",
    "x64",
    "2.35",
    ["--test-spore-version"],
    true,
  );
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("0.4.0\n");
  expect(child.stderr).toBe("");
});

for (const arch of ["arm64", "x64"]) {
  test(`npm launcher admits macOS ${arch} without a glibc report`, async () => {
    const child = await launch("darwin", arch, undefined, ["--version"], true);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("RUNTIME_STARTED\n");
    expect(child.stderr).toBe("");
  });

  test(`macOS ${arch} missing native package reports the exact reinstall command`, async () => {
    const child = await launch("darwin", arch, undefined);
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe(
      `Fungi's native package for darwin-${arch} is missing or doesn't match this version. Reinstall: npm i -g @fungi.computer/spore@0.4.0\n`,
    );
  });
}

for (const release of ["21.6.0", "22.5.0"]) {
  test(`macOS Darwin ${release} is refused before native loading`, async () => {
    const child = await launch("darwin", "arm64", undefined, [], true, release);
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe(requirement);
  });
}
for (const release of ["22.6.0", "23.0.0", "24.0.0"]) {
  test(`macOS Darwin ${release} meets the supported floor`, async () => {
    const child = await launch(
      "darwin",
      "arm64",
      undefined,
      [],
      true,
      release,
      "Apple M1",
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("RUNTIME_STARTED\n");
    expect(child.stderr).toBe("");
  });
}
test("x64 Node on Apple Silicon is refused before starting Rosetta Bun", async () => {
  const child = await launch(
    "darwin",
    "x64",
    undefined,
    [],
    true,
    "23.0.0",
    "Apple M2",
  );
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toContain(
    "Use arm64 Node on Apple Silicon and reinstall the CLI",
  );
});

for (const model of ["VirtualApple", null]) {
  test(`macOS x64 refuses ${model ?? "empty CPU metadata"} before native loading`, async () => {
    const child = await launch(
      "darwin",
      "x64",
      undefined,
      [],
      true,
      "23.0.0",
      model,
    );
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain(
      "Use arm64 Node on Apple Silicon and reinstall the CLI",
    );
  });
}
