import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createAppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import { createWhistle } from "@fungi.computer/whistle";
import {
  localExtensions,
  type LocalExtensions,
} from "@fungi.computer/truffle/extensions";
import { runFungiCli } from "../src/cli.js";
import { projectExtensionParts } from "../src/extension-command.js";
import { TuiFrame } from "../src/frame.js";
import { programPanes } from "../src/panes/terminal/index.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey } from "./native-readiness.js";

/**
 * One real installed extension, end to end in disposable custody: a Git
 * package pinned to its commit, its program opened from Open pane in a real
 * PTY, and its tools called through Local's execute composition by the one
 * Agent granted them.
 */
const local = resolve(import.meta.dir, "../../../runtimes/local");
const fixture = join(local, "test", "fixtures", "extension-counter");
let scratch: string;
let home: string;
let project: string;
let agentA: string;
let agentB: string;
let source: string;
let owner: LocalExtensions;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "fungi-pane-ext-")));
  home = join(scratch, "home");
  project = join(scratch, "project");
  agentA = join(project, ".fungi", "agents", "local_store_a");
  agentB = join(project, ".fungi", "agents", "local_store_b");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(agentA, { recursive: true }),
    mkdir(agentB, { recursive: true }),
  ]);
  const work = join(scratch, "work");
  source = join(scratch, "counter.git");
  await cp(fixture, work, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=f@fungi.test", "-c", "user.name=F", ...args],
      { cwd, encoding: "utf8" },
    );
  git(scratch, "init", "-q", "--bare", "-b", "main", source);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "counter");
  git(work, "push", "-q", source, "HEAD:main");
  owner = localExtensions({ home });
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fungi(...argv: string[]) {
  let output = "";
  await runFungiCli(
    argv,
    {
      cwd: project,
      stdout: {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
    },
    { extensions: owner },
  );
  return output;
}

/** Local's real tool composition for one Agent store, in its own process. */
async function executeAs(store: string, code: string) {
  const child = Bun.spawn(
    ["bun", "test/fixtures/execute-as-agent.fixture.mjs", project, store, code],
    {
      cwd: local,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0)
    throw new Error(`Agent turn failed (${String(status)}): ${stderr}`);
  return stdout;
}

test("an installed program opens from Open pane and only the granted Agent's tools drive it", async () => {
  expect(await fungi("extension", "add", `git+file://${source}#main`)).toMatch(
    /Installed counter 1\.0\.0 \([0-9a-f]{40}\)/u,
  );
  await fungi("extension", "enable", "project", "counter");
  await fungi(
    "extension",
    "enable",
    "agent",
    "counter",
    join(".fungi", "agents", "local_store_a"),
  );
  const parts = await projectExtensionParts(owner, project, (error) => {
    throw error;
  });
  const fixtureSession = createTuiFixture();
  const commands = createWhistle();
  const host = createAppSurfaceCommandHost(commands);
  const client = createQueryClient();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={fixtureSession.session}
        commands={commands}
        commandHost={host}
        paneKinds={programPanes(parts.programs)}
      />
    </QueryClientProvider>,
    { width: 100, height: 30 },
  );
  const frame = async (check: (text: string) => boolean) => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      await act(async () => {
        await setup.renderOnce();
      });
      if (check(setup.captureCharFrame())) return;
      await Bun.sleep(10);
    }
    throw new Error(`Frame never matched:\n${setup.captureCharFrame()}`);
  };
  const run = async (title: string) => {
    const row = host.active().palette.find((entry) => entry.title === title);
    if (row === undefined) throw new Error(`${title} command missing`);
    await act(async () => {
      await host.execute(row.commandId, { origin: "programmatic" });
    });
  };
  try {
    await frame((text) => text.includes("Ask anything"));
    // The one Open pane picker lists every launcher by name: the built-in
    // Local terminal, then the installed Counter program, which the
    // extension contributes with no Fungi source change.
    await run("Open pane");
    await frame((text) => text.includes("Counter"));
    expect(setup.captureCharFrame()).toContain("Local terminal");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await frame((text) => text.includes("count: 0"));

    expect(
      JSON.parse(await executeAs(agentA, "return await counter.increment({})")),
    ).toEqual({ running: true, count: 1 });
    await frame((text) => text.includes("count: 1"));
    expect(await executeAs(agentB, "return typeof counter")).toBe(
      '"undefined"',
    );

    // Disabling the project applies at the next start: the running program
    // keeps working, and only a fresh project read drops its launcher.
    await fungi("extension", "disable", "project", "counter");
    expect(
      JSON.parse(await executeAs(agentA, "return await counter.read({})")),
    ).toEqual({ running: true, count: 1 });
    expect(setup.captureCharFrame()).toContain("count: 1");
    expect(
      (
        await projectExtensionParts(owner, project, (error) => {
          throw error;
        })
      ).programs,
    ).toEqual([]);

    // An idle program, like an idle shell, closes at once with no
    // confirmation; only running jobs would ask first.
    const close = host
      .active()
      .palette.find((entry) => entry.title === "Close pane");
    if (close === undefined) throw new Error("Close pane command missing");
    await act(async () => {
      await host.execute(close.commandId, { origin: "programmatic" });
    });
    await frame((text) => !text.includes("count: 1"));
    expect(
      JSON.parse(await executeAs(agentA, "return await counter.read({})")),
    ).toEqual({ running: false });
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    host.dispose();
    client.clear();
  }
}, 120_000);

test("a copied folder with its own activations file shows no program", async () => {
  const copy = join(scratch, "copy");
  await cp(project, copy, { recursive: true });
  await mkdir(join(copy, ".fungi", "extensions"), { recursive: true });
  await cp(
    join(home, ".fungi", "extensions", "activations.json"),
    join(copy, ".fungi", "extensions", "activations.json"),
  );
  expect(
    (
      await projectExtensionParts(owner, copy, (error) => {
        throw error;
      })
    ).programs,
  ).toEqual([]);
});
