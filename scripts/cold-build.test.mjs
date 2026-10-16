import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../../..");

test("TUI builds and checks in a clean checkout after Parakeet cache restoration", () => {
  const parent = join(root, ".botanical/tui-cold-build");
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, "run-"));
  const checkout = join(work, "checkout");
  let passed = false;

  function run(label, command, args, cwd = checkout) {
    const log = join(work, `${label}.log`);
    const descriptor = openSync(log, "w", 0o600);
    try {
      execFileSync(command, args, {
        cwd,
        env: {
          ...process.env,
          CARGO_BUILD_JOBS: "1",
          RAYON_NUM_THREADS: "1",
          GOMAXPROCS: "1",
          UV_THREADPOOL_SIZE: "1",
        },
        stdio: ["ignore", descriptor, descriptor],
      });
    } catch (error) {
      throw new Error(`${label} failed; inspect private log ${log}`, {
        cause: error,
      });
    } finally {
      closeSync(descriptor);
    }
  }

  function turbo(label, tasks, filter, cacheMode = "local:rw") {
    run(label, "pnpm", [
      "turbo:run",
      "run",
      ...tasks,
      `--filter=${filter}`,
      "--concurrency=3",
      `--cache=${cacheMode}`,
      "--output-logs=new-only",
    ]);
  }

  try {
    // Test the committed source, with its own install and no borrowed dist.
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    run(
      "clone",
      "git",
      ["clone", "--shared", "--no-checkout", root, checkout],
      root,
    );
    run("checkout", "git", ["checkout", "--detach", revision]);
    assert.equal(existsSync(join(checkout, "packages/parakeet/dist")), false);
    // Prepare the locked store and supply-chain verdict before proving the
    // offline install. Other checkouts can evict the shared verdict cache.
    run("fetch", "pnpm", ["fetch", "--ignore-scripts"]);
    run("install", "pnpm", ["install", "--offline", "--frozen-lockfile"]);

    const injected = realpathSync(
      join(checkout, "apps/tui/node_modules/@fungi.computer/parakeet"),
    );
    const owner = join(checkout, "packages/parakeet");
    assert.notEqual(
      injected,
      owner,
      "TUI must retain its injected peer context",
    );
    assert.equal(existsSync(join(injected, "dist/headless.d.ts")), false);

    // Compile rather than restore Parakeet once, exercising pnpm's normal
    // post-build injection. Keep the ordinary artifact cache for unrelated
    // native prerequisites; each checkout still starts without build outputs.
    turbo("cold-parakeet", ["build"], "@fungi.computer/parakeet", "local:w");
    assert.ok(existsSync(join(injected, "dist/headless.d.ts")));
    rmSync(join(owner, "dist"), { recursive: true });
    rmSync(join(injected, "dist"), { recursive: true });
    assert.equal(existsSync(join(checkout, "apps/tui/dist")), false);

    turbo(
      "restored-tui",
      ["build", "lint", "typecheck"],
      "@fungi.computer/spore",
    );
    assert.match(
      readFileSync(join(work, "restored-tui.log"), "utf8"),
      /@fungi\.computer\/parakeet:build: cache hit/,
    );
    assert.equal(
      readFileSync(join(injected, "dist/headless.d.ts"), "utf8"),
      readFileSync(join(owner, "dist/headless.d.ts"), "utf8"),
    );
    assert.ok(existsSync(join(checkout, "apps/tui/dist/cli.js")));
    const consumer = createRequire(join(checkout, "apps/tui/package.json"));
    const parakeet = createRequire(join(injected, "package.json"));
    assert.equal(parakeet.resolve("react"), consumer.resolve("react"));
    assert.notEqual(
      parakeet.resolve("react"),
      createRequire(join(owner, "package.json")).resolve("react"),
    );

    // Cached consumers still need the installed runtime files. This catches a
    // sync task that was accidentally made cacheable or moved into TUI's script.
    rmSync(join(injected, "dist"), { recursive: true });
    turbo(
      "cached-tui",
      ["build", "lint", "typecheck"],
      "@fungi.computer/spore",
    );
    assert.match(
      readFileSync(join(work, "cached-tui.log"), "utf8"),
      /@fungi\.computer\/tui:build: cache hit/,
    );
    run(
      "headless-import",
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "await import('@fungi.computer/parakeet/headless');",
      ],
      join(checkout, "apps/tui"),
    );
    assert.equal(
      readFileSync(join(injected, "dist/headless.js"), "utf8"),
      readFileSync(join(owner, "dist/headless.js"), "utf8"),
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: checkout,
        encoding: "utf8",
      }).trim(),
      "",
    );
    passed = true;
  } finally {
    // Keep a failure's checkout and private logs for diagnosis.
    if (passed) rmSync(work, { recursive: true, force: true });
  }
});
