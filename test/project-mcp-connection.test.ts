import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  createPrivateLocalServiceManager,
  type PrivateLocalServiceConnection,
} from "@fungi.computer/truffle/service";
import { runFungiCli } from "../src/cli.js";
import {
  forgetProjectMcpConnection,
  readProjectMcpConnection,
  saveProjectMcpConnection,
} from "../src/project-mcp-connection.js";

const endpoint = "http://localhost:8787/api/teams/team_test/mcp";

test("project MCP selection survives restart, switches, and stays local to the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-project-mcp-"));
  try {
    const other = join(root, "other");
    await mkdir(other);
    assert.equal(await readProjectMcpConnection(root), undefined);
    await saveProjectMcpConnection(root, endpoint);
    assert.equal(await readProjectMcpConnection(root), endpoint);
    assert.equal(await readProjectMcpConnection(other), undefined);
    await saveProjectMcpConnection(
      root,
      "https://hub.example/api/teams/next/mcp",
    );
    assert.equal(
      await readProjectMcpConnection(root),
      "https://hub.example/api/teams/next/mcp",
    );
    await forgetProjectMcpConnection(root);
    assert.equal(await readProjectMcpConnection(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project MCP selection rejects invalid saved state and endpoint lookalikes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-project-mcp-"));
  try {
    await assert.rejects(
      saveProjectMcpConnection(root, "http://localhost.evil.com/mcp"),
      /HTTPS|loopback/u,
    );
    await mkdir(join(root, ".fungi"));
    await writeFile(join(root, ".fungi", "team-mcp.json"), "{oops");
    await assert.rejects(
      readProjectMcpConnection(root),
      /saved Team MCP connection/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI shows, switches, and forgets the project connection; run reuses it", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-project-mcp-cli-"));
  try {
    let output = "";
    const io = {
      cwd: root,
      stdout: {
        write: (chunk: string) => {
          output += chunk;
          return true;
        },
      },
    };
    await runFungiCli(["mcp", "use", endpoint], io);
    await runFungiCli(["mcp", "show"], io);
    assert.match(
      output,
      /Team MCP for .*http:\/\/localhost:8787\/api\/teams\/team_test\/mcp/u,
    );
    const observed = Promise.withResolvers<string | undefined>();
    const stop = new Error("selection observed");
    await assert.rejects(
      runFungiCli(["run", "check"], io, {
        createServiceManager: () => ({
          ...createPrivateLocalServiceManager(),
          connect: (selection) => {
            observed.resolve(selection.fungiMcp?.endpoint);
            return Promise.reject(stop);
          },
        }),
      }),
      (cause) => cause === stop,
    );
    assert.equal(await observed.promise, endpoint);
    await runFungiCli(["mcp", "forget"], io);
    assert.equal(await readProjectMcpConnection(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful explicit one-shot selection becomes the next default", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-project-mcp-run-"));
  try {
    await runFungiCli(
      ["run", "check", "--fungi-mcp", endpoint],
      { cwd: root },
      {
        createServiceManager: () => ({
          ...createPrivateLocalServiceManager(),
          connect: () =>
            Promise.resolve(
              // SAFETY: The injected runOneShot stub does not inspect the fake connection's Session.
              {
                session: {},
                close: () => Promise.resolve(),
              } as PrivateLocalServiceConnection,
            ),
        }),
        runOneShot: () => Promise.resolve(),
      },
    );
    assert.equal(await readProjectMcpConnection(root), endpoint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
