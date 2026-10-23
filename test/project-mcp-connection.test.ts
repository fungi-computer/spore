import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "bun:test";
import {
  createPrivateLocalServiceManager,
  type PrivateLocalServiceConnection,
} from "@fungi.computer/truffle/service";
import { runFungiCli } from "../src/cli.js";
import { createPrivateCredentialStore } from "@fungi.computer/truffle";
import {
  forgetProjectMcpConnection,
  readProjectMcpConnection,
  saveProjectMcpConnection,
} from "../src/project-mcp-connection.js";

const endpoint = "http://localhost:8787/api/teams/team_test/mcp";

test("CLI reads an Oyster key from stdin and saves only its authentication selection in the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-oyster-mcp-cli-"));
  const home = join(root, "home");
  const key = "oyk_disposable-cli-test-key";
  let output = "";
  try {
    await runFungiCli(
      ["mcp", "use", "https://oyster.test/mcp", "--from-file", "-"],
      {
        cwd: root,
        stdin: Readable.from([`${key}\n`]),
        stdout: {
          write: (chunk: string) => {
            output += chunk;
            return true;
          },
        },
      },
      {},
      home,
    );
    const project = await readFile(
      join(root, ".fungi", "team-mcp.json"),
      "utf8",
    );
    assert.deepEqual(JSON.parse(project), {
      endpoint: "https://oyster.test/mcp",
      authentication: "oyster-key",
    });
    assert.equal(project.includes(key), false);
    assert.equal(output.includes(key), false);
    const credentialPath = join(home, ".config", "fungi", "credentials.json");
    assert.deepEqual(
      await createPrivateCredentialStore(credentialPath).read(
        "oyster-mcp:https://oyster.test",
      ),
      { type: "api_key", key },
    );
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
    const stop = new Error("Oyster selection observed");
    let connected = false;
    await assert.rejects(
      runFungiCli(
        ["run", "check"],
        { cwd: root, stdout: { write: () => true } },
        {
          createServiceManager: () => ({
            ...createPrivateLocalServiceManager(),
            connect: (selection) => {
              assert.deepEqual(selection.fungiMcp, {
                endpoint: "https://oyster.test/mcp",
                authentication: "oyster-key",
              });
              connected = true;
              return Promise.reject(stop);
            },
          }),
        },
        home,
      ),
      (cause) => cause === stop,
    );
    assert.equal(connected, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project MCP selection survives restart, switches, and stays local to the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-project-mcp-"));
  try {
    const other = join(root, "other");
    await mkdir(other);
    assert.equal(await readProjectMcpConnection(root), undefined);
    await saveProjectMcpConnection(root, endpoint);
    assert.deepEqual(await readProjectMcpConnection(root), { endpoint });
    assert.equal(await readProjectMcpConnection(other), undefined);
    await saveProjectMcpConnection(
      root,
      "https://hub.example/api/teams/next/mcp",
    );
    assert.equal(
      (await readProjectMcpConnection(root))?.endpoint,
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
                sandboxStatus: () =>
                  Promise.resolve({
                    state: "available",
                    requireSandbox: false,
                  }),
                session: {},
                close: () => Promise.resolve(),
              } as PrivateLocalServiceConnection,
            ),
        }),
        runOneShot: () => Promise.resolve(),
      },
    );
    assert.deepEqual(await readProjectMcpConnection(root), { endpoint });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
