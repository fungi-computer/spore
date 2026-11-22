import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deployDetached,
  detachInjectedWorkspaceFiles,
  packageLocalDeployArguments,
} from "./injected-deploy.mjs";
import { nativeFrameDeployArguments } from "./native-frame-deploy.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeWorkspace(work, consumerManifest) {
  writeFileSync(
    join(work, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  writeJson(join(work, "package.json"), { name: "root", private: true });
  const library = join(work, "packages/truffle");
  const consumer = join(work, "packages/spore");
  mkdirSync(join(library, "dist"), { recursive: true });
  mkdirSync(consumer, { recursive: true });
  writeJson(join(library, "package.json"), {
    name: "@fungi.computer/truffle",
    version: "1.0.0",
    files: ["dist"],
  });
  const source = join(library, "dist/private-local-sandbox.js");
  writeFileSync(source, "export {};\n");
  writeJson(join(consumer, "package.json"), {
    name: "@fungi.computer/spore",
    version: "1.0.0",
    dependencies: { "@fungi.computer/truffle": "workspace:*" },
    ...consumerManifest,
  });
  return source;
}

test("the native-frame deploy leaves source dist files with one link", async () => {
  const work = mkdtempSync(join(tmpdir(), "native-frame-deploy-"));
  try {
    const source = writeWorkspace(work, {});

    execFileSync("pnpm", nativeFrameDeployArguments(join(work, "out")), {
      cwd: work,
      stdio: "pipe",
      env: { ...process.env, CI: "true" },
    });

    await detachInjectedWorkspaceFiles(join(work, "out"));
    assert.equal(statSync(source).nlink, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the package-local deploy leaves source dist files with one link", async () => {
  const work = mkdtempSync(join(tmpdir(), "package-local-deploy-"));
  try {
    const source = writeWorkspace(work, {
      dependenciesMeta: { "@fungi.computer/truffle": { injected: true } },
    });
    const destination = join(work, "out");

    await deployDetached(
      packageLocalDeployArguments(destination),
      destination,
      {
        cwd: work,
        env: { ...process.env, CI: "true" },
      },
    );

    assert.equal(statSync(source).nlink, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
