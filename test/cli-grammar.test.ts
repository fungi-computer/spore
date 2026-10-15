import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { createPrivateModels } from "@fungi.computer/local";
import type { LocalAuthCliOptions } from "@fungi.computer/local/auth";
import { createPrivateLocalServiceManager } from "@fungi.computer/local/service";
import { runFungiCli } from "../src/cli.js";

test("--yes is accepted for the bare CLI and never mounts an unattended agent UI", async () => {
  let output = "";
  const models: NonNullable<LocalAuthCliOptions["models"]> = {
    getProviders: () =>
      createPrivateModels()
        .getProviders()
        .filter((provider) => provider.id === "openai"),
    checkAuth: () => Promise.resolve({ type: "oauth" }),
    login: () => Promise.reject(new Error("unexpected login")),
    logout: () => Promise.resolve(),
  };
  await runFungiCli(
    ["--yes"],
    {
      authModels: models,
      interactive: false,
      stdout: {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
    },
    {
      createRenderer: () => Promise.reject(new Error("unexpected renderer")),
    },
  );
  expect(output).toContain("Use fungi run <prompt> for automation");
});

test("help describes the actual entry modes without opening a Session", async () => {
  for (const flag of ["--help", "-h"]) {
    let output = "";
    await runFungiCli([flag], {
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
      },
    });
    expect(output).toContain("fungi run [prompt]");
    expect(output).toContain("fungi serve --workers");
    expect(output).toContain("fungi stop");
    expect(output).toContain("fungi login");
    expect(output).toContain("fungi status");
    expect(output).toContain("fungi logout");
    expect(output).not.toContain("--connect");
    expect(output).not.toContain("--model");
    expect(output).not.toContain("--reasoning");
    expect(output).toContain("/model and /thinking");
  }
});

test("Anthropic login help explains the SSH paste-code path", async () => {
  let output = "";
  await runFungiCli(["login", "--help"], {
    stdout: {
      write: (chunk) => {
        output += String(chunk);
        return true;
      },
    },
  });
  expect(output).toContain(
    "fungi login --provider anthropic --auth-type oauth",
  );
  expect(output).toContain("over SSH");
  expect(output).toContain(
    "paste the authorization code or final redirect URL",
  );
});

test("top-level auth commands use the injected Local owner before renderer creation", async () => {
  const calls: {
    action: string;
    method: string | undefined;
    output: string;
  }[] = [];
  const renderer = () => {
    throw new Error("auth commands must not create a renderer");
  };
  for (const [action, method] of [
    ["login", "device-code"],
    ["status", undefined],
    ["logout", undefined],
  ] as const) {
    await runFungiCli(
      method === undefined ? [action] : [action, "--method", method],
      {},
      {
        createRenderer: () => Promise.resolve(renderer()),
        runAuth: (received, options) =>
          Promise.resolve().then(() => {
            calls.push({
              action: received,
              method: options?.method,
              output: "",
            });
          }),
      },
    );
  }
  expect(calls.map(({ action, method }) => [action, method])).toEqual([
    ["login", "device-code"],
    ["status", undefined],
    ["logout", undefined],
  ]);
});

test("default top-level auth dispatch uses the maintained Models owner", async () => {
  let selectedMethod: string | undefined;
  let statusOutput = "";
  const authModels: NonNullable<LocalAuthCliOptions["models"]> = {
    getProviders: () =>
      createPrivateModels()
        .getProviders()
        .filter((provider) => provider.id === "openai"),
    checkAuth: () => Promise.resolve({ type: "oauth" }),
    login: async (_provider, _method, interaction) => {
      selectedMethod = await interaction.prompt({
        type: "select",
        message: "method",
        options: [{ id: "device_code", label: "device" }],
      });
      return { type: "oauth", access: "", refresh: "", expires: 0 };
    },
    logout: () => Promise.resolve(),
  };
  const output = {
    write: (chunk: string) => {
      statusOutput += chunk;
      return true;
    },
  };
  const createRenderer = () =>
    Promise.reject(
      new Error("top-level auth must run before renderer creation"),
    );
  await runFungiCli(
    ["status"],
    { authModels, stdout: output },
    { createRenderer },
  );
  await runFungiCli(
    [
      "login",
      "--provider",
      "openai",
      "--auth-type",
      "oauth",
      "--method",
      "device-code",
    ],
    { authModels, stdout: output },
    { createRenderer },
  );
  expect(statusOutput).toContain("configured (oauth)");
  expect(selectedMethod).toBe("device_code");
});

test("--method is rejected before unrelated command dispatch", async () => {
  let authCalls = 0;
  await assert.rejects(
    runFungiCli(
      ["resume", "--method", "browser"],
      {},
      {
        runAuth: () => {
          authCalls += 1;
          return Promise.resolve();
        },
        createRenderer: () =>
          Promise.reject(new Error("renderer must not be reached")),
      },
    ),
    /--method is only valid with fungi login/u,
  );
  expect(authCalls).toBe(0);
});

test("invalid commands and unknown flags are rejected before dispatch", async () => {
  await assert.rejects(
    runFungiCli(["not-a-command"]),
    /Unknown fungi command/u,
  );
  await assert.rejects(runFungiCli(["--not-an-option"]));
  await assert.rejects(
    runFungiCli(["run", "one", "two"]),
    /at most one prompt/u,
  );
});

test("sessions grammar requires a listed number or --last and rejects unrelated options", async () => {
  for (const args of [
    ["sessions", "resume"],
    ["sessions", "resume", "0"],
    ["sessions", "resume", "1", "--last"],
    ["sessions", "list", "--last"],
    ["sessions", "list", "--model", "fixture"],
    ["sessions", "show"],
    ["sessions", "status", "one", "--last"],
    ["sessions", "status", "one", "--errors"],
    ["sessions", "watch", "one", "--last"],
    ["sessions", "show", "one", "--errors", "--json", "--provider", "other"],
  ])
    await assert.rejects(
      runFungiCli(args),
      /Usage: fungi sessions|Session number|accepts only/u,
    );
  let help = "";
  await runFungiCli(["sessions", "--help"], {
    stdout: {
      write: (chunk) => {
        help += String(chunk);
        return true;
      },
    },
  });
  assert.match(help, /sessions resume <number\|session-id\|prefix>/u);
});

test("stop awaits the service owner without opening a renderer or restarting it", async () => {
  const stopping = Promise.withResolvers<{ kind: "stopped" }>();
  const entered = Promise.withResolvers<undefined>();
  let output = "";
  const running = runFungiCli(
    ["stop"],
    {
      stdout: {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
    },
    {
      createRenderer: () => {
        throw new Error("must not mount");
      },
      createServiceManager: () => ({
        ...createPrivateLocalServiceManager(),
        start: () => {
          throw new Error("must not start");
        },
        stop: () => {
          entered.resolve(undefined);
          return stopping.promise;
        },
      }),
    },
  );
  await entered.promise;
  expect(output).toBe("");
  stopping.resolve({ kind: "stopped" });
  await running;
  expect(output).toContain("Local service stopped");
});

test.each([true, false])(
  "stop reports an absent service in one clean line (record cleaned: %s)",
  async (recordCleaned) => {
    let output = "";
    await runFungiCli(
      ["stop"],
      {
        interactive: false,
        stdout: {
          write(chunk) {
            output += String(chunk);
            return true;
          },
        },
      },
      {
        createServiceManager: () => ({
          ...createPrivateLocalServiceManager(),
          stop: () => Promise.resolve({ kind: "not-running", recordCleaned }),
        }),
      },
    );
    expect(output).toBe(
      recordCleaned
        ? "Local service wasn't running; cleaned up its record. Saved Sessions preserved.\n"
        : "Local service wasn't running. Saved Sessions preserved.\n",
    );
  },
);

test("stop propagates shutdown failure and rejects selection arguments", async () => {
  const failure = new Error("owner drain failed");
  await assert.rejects(
    runFungiCli(
      ["stop"],
      {},
      {
        createServiceManager: () => ({
          ...createPrivateLocalServiceManager(),
          stop: () => Promise.reject(failure),
        }),
      },
    ),
    (cause) => cause === failure,
  );
  for (const args of [
    ["stop", "other"],
    ["stop", "--db", "other"],
    ["stop", "--provider", "other"],
  ]) {
    await assert.rejects(
      runFungiCli(args),
      /does not accept arguments or options/,
    );
  }
});

test("hosted capability selection uses an endpoint and a local Session", async () => {
  for (const args of [["run", "--fungi-mcp-credential", "./credential"]])
    await assert.rejects(runFungiCli(args), /Unknown option/u);
  for (const args of [
    ["run", "--connect", "http://127.0.0.1:43123"],
    ["stop"],
    ["serve"],
  ])
    await assert.rejects(
      runFungiCli([...args, "--fungi-mcp", "https://hub.test/mcp"]),
      /only valid for a local Session, fungi login, fungi logout or fungi computer/u,
    );
});

test("fungi login sends the selected MCP endpoint to the OAuth enrollment flow", async () => {
  let selected: string | undefined;
  let output = "";
  await runFungiCli(
    ["login", "--fungi-mcp", "https://hub.test/api/teams/team-1/mcp"],
    {
      stdout: {
        write(chunk: string | Uint8Array) {
          output += String(chunk);
          return true;
        },
      },
    },
    {
      signInFungi: (endpoint) => {
        selected = endpoint;
        return Promise.resolve();
      },
    },
  );
  expect(selected).toBe("https://hub.test/api/teams/team-1/mcp");
  expect(output).toContain("Fungi login complete");
});

test("fungi computer attach accepts the notice, attaches the folder and runs until stopped", async () => {
  let output = "";
  const calls: unknown[] = [];
  await runFungiCli(
    [
      "computer",
      "attach",
      "cedar",
      "project",
      "--fungi-mcp",
      "https://hub.test/api/teams/team-1/mcp",
      "--host-label",
      "Levi machine",
      "--yes",
    ],
    {
      cwd: "/work",
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
      },
    },
    {
      computerOwners: {
        attach: (endpoint, input) => {
          calls.push(["attach", endpoint, input]);
          return Promise.resolve({
            kind: "attached",
            computerId: "computer_one",
            computerName: "cedar",
            backendId: "local-abcdefghijklmnop",
            rootPath: "/work/project",
          });
        },
        run: (endpoint, computer, options) => {
          calls.push(["run", endpoint, computer]);
          options.onStatus?.({ kind: "online" });
          return Promise.resolve("stopped");
        },
      },
    },
  );
  expect(calls).toEqual([
    [
      "attach",
      "https://hub.test/api/teams/team-1/mcp",
      {
        computer: "cedar",
        folderPath: "/work/project",
        hostLabel: "Levi machine",
      },
    ],
    ["run", "https://hub.test/api/teams/team-1/mcp", "computer_one"],
  ]);
  expect(output).toContain("as you, starting in this folder");
  expect(output).toContain("The Computer wins");
  expect(output).toContain("cedar: online");
  expect(output).toContain("re-run attach to reconnect");
});

test("fungi computer attach refuses to run unattended without --yes", async () => {
  let attached = false;
  await assert.rejects(
    runFungiCli(
      [
        "computer",
        "attach",
        "cedar",
        "/work/project",
        "--fungi-mcp",
        "https://hub.test/api/teams/team-1/mcp",
      ],
      { interactive: false, stdout: { write: () => true } },
      {
        computerOwners: {
          attach: () => {
            attached = true;
            return Promise.resolve({ kind: "not-found" });
          },
        },
      },
    ),
    /--yes/u,
  );
  expect(attached).toBe(false);
});

test("fungi computer detach delegates to the Local attachment owner", async () => {
  let output = "";
  const calls: unknown[] = [];
  await runFungiCli(
    [
      "computer",
      "detach",
      "cedar",
      "--fungi-mcp",
      "https://hub.test/api/teams/team-1/mcp",
    ],
    {
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
      },
    },
    {
      computerOwners: {
        detach: (endpoint, computer) => {
          calls.push([String(endpoint), computer]);
          return Promise.resolve({ kind: "detached" });
        },
      },
    },
  );
  expect(calls).toEqual([["https://hub.test/api/teams/team-1/mcp", "cedar"]]);
  expect(output).toContain("Detached this machine from cedar");
});

test("fungi logout prints Local's shared outcome including unconfirmed Computers", async () => {
  const sink = capture();
  const message =
    "Signed out here. Computer cedar may still be attached. Visit https://hub.test/teams/team-1/computers";
  await runFungiCli(
    ["logout", "--fungi-mcp", "https://hub.test/api/teams/team-1/mcp"],
    { stdout: sink.stdout },
    {
      signOutFungi: () =>
        Promise.resolve({
          kind: "revoked",
          message,
          unconfirmedComputers: [
            { name: "cedar", url: "https://hub.test/teams/team-1/computers" },
          ],
        }),
    },
  );
  expect(sink.text()).toBe(`${message}\n`);
});

test("one-shot CLI sends the endpoint to Local", async () => {
  const stopped = new Error("selection observed");
  let selected:
    | Parameters<
        ReturnType<typeof createPrivateLocalServiceManager>["connect"]
      >[0]
    | undefined;
  await assert.rejects(
    runFungiCli(
      [
        "run",
        "hello",
        "--fungi-mcp",
        "https://hub.test/api/teams/selected/mcp",
        "--cd",
        "project",
      ],
      { cwd: "/tmp/local-selection" },
      {
        createServiceManager: () => ({
          ...createPrivateLocalServiceManager(),
          connect: (selection) => {
            selected = selection;
            return Promise.reject(stopped);
          },
        }),
      },
    ),
    (cause) => cause === stopped,
  );
  expect(selected).toMatchObject({
    invocationRoot: "/tmp/local-selection/project",
    fungiMcp: {
      endpoint: "https://hub.test/api/teams/selected/mcp",
    },
  });
});

function capture() {
  let output = "";
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        output += String(chunk);
        return true;
      },
    },
    text: () => output,
  };
}

test("--version and -V print the package version", async () => {
  for (const flag of ["--version", "-V"]) {
    const sink = capture();
    await runFungiCli([flag], { stdout: sink.stdout });
    expect(sink.text()).toBe("fungi 0.1.0\n");
  }
});

test("per-command help works through --help and fungi help", async () => {
  for (const args of [
    ["login", "--help"],
    ["help", "login"],
  ]) {
    const sink = capture();
    await runFungiCli(args, { stdout: sink.stdout });
    expect(sink.text()).toContain("fungi login --fungi-mcp <url>");
    expect(sink.text()).toContain("One browser sign-in serves models");
  }
  const global = capture();
  await runFungiCli(["help"], { stdout: global.stdout });
  expect(global.text()).toContain("Get started:");
  expect(global.text()).toContain("-V, --version");
  const logout = capture();
  await runFungiCli(["logout", "-h"], { stdout: logout.stdout });
  expect(logout.text()).toContain("fungi logout --fungi-mcp <url>");
  await assert.rejects(
    runFungiCli(["help", "nope"]),
    /Unknown fungi command: nope/u,
  );
});

test("fungi logout --fungi-mcp removes the Fungi MCP login for that origin", async () => {
  const selected: string[] = [];
  const sink = capture();
  await runFungiCli(
    ["logout", "--fungi-mcp", "https://hub.test/api/teams/team-1/mcp"],
    { stdout: sink.stdout },
    {
      signOutFungi: (endpoint) => {
        selected.push(endpoint);
        return Promise.resolve({
          kind: "removed",
          message:
            "Signed out here. Couldn't confirm with Fungi; you can revoke this login under Connected logins.",
          unconfirmedComputers: [],
        });
      },
      runAuth: () => Promise.reject(new Error("provider logout must not run")),
    },
  );
  expect(selected).toEqual(["https://hub.test/api/teams/team-1/mcp"]);
  expect(sink.text()).toBe(
    "Signed out here. Couldn't confirm with Fungi; you can revoke this login under Connected logins.\n",
  );
  await assert.rejects(
    runFungiCli([
      "logout",
      "--fungi-mcp",
      "https://hub.test",
      "--provider",
      "openai",
    ]),
    /cannot be combined with provider login options/u,
  );
});

test("fungi status includes the saved Fungi MCP login", async () => {
  for (const [login, expected] of [
    [
      { issuer: "https://hub.test", accessExpiresAt: new Date(0) },
      "Fungi: https://hub.test",
    ],
    [undefined, "Fungi: Sign in to Fungi"],
  ] as const) {
    const sink = capture();
    await runFungiCli(
      ["status"],
      { stdout: sink.stdout },
      {
        runAuth: () => Promise.resolve(),
        readFungiStatus: () => Promise.resolve(login),
      },
    );
    expect(sink.text()).toContain(expected);
  }
});

test("an interactive Fungi MCP login confirms before replacing another origin", async () => {
  const { Readable } = await import("node:stream");
  const sink = capture();
  let answer: boolean | undefined;
  await runFungiCli(
    ["login", "--fungi-mcp", "https://hub.test/api/teams/team-1/mcp"],
    { stdout: sink.stdout, stdin: Readable.from(["y\n"]), interactive: true },
    {
      signInFungi: async (_endpoint, options) => {
        answer = await options.confirmReplace?.(
          "https://preview.test",
          "https://hub.test",
        );
      },
    },
  );
  expect(answer).toBe(true);
  expect(sink.text()).toContain("Fungi is logged in to https://preview.test.");
  expect(sink.text()).toContain("https://hub.test?");
  let offered = true;
  await runFungiCli(
    ["login", "--fungi-mcp", "https://hub.test/api/teams/team-1/mcp"],
    { stdout: capture().stdout, interactive: false },
    {
      signInFungi: (_endpoint, options) => {
        offered = options.confirmReplace !== undefined;
        return Promise.resolve();
      },
    },
  );
  expect(offered).toBe(false);
});

test("a failed run without any model login points at fungi login", async () => {
  const stopped = new Error("model stream failed");
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(
      runFungiCli(
        ["run", "hello"],
        {
          cwd: "/tmp",
          authModels: {
            getProviders: () =>
              createPrivateModels()
                .getProviders()
                .filter((provider) => provider.id === "openai"),
            checkAuth: () => Promise.resolve(undefined),
            login: () => Promise.reject(new Error("unused")),
            logout: () => Promise.resolve(),
          },
        },
        {
          createServiceManager: () => ({
            ...createPrivateLocalServiceManager(),
            connect: () => Promise.reject(stopped),
          }),
        },
      ),
      (cause) => cause === stopped,
    );
  } finally {
    process.stderr.write = original;
  }
  expect(written.join("")).toContain("Sign in to Fungi with fungi login");
});

test("fungi computers lists Team state and start uses lantern progress without opening a Session", async () => {
  let output = "";
  const endpoint = "https://hub.test/api/teams/team-1/mcp";
  const io = {
    interactive: false,
    stdout: {
      write: (chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      },
    },
  };
  const owners = {
    list: () =>
      Promise.resolve([
        { computerId: "a", name: "cedar", state: "running" as const },
        { computerId: "b", name: "birch", state: "sleeping" as const },
        { computerId: "c", name: "elm", state: "queued" as const, position: 3 },
        { computerId: "d", name: "oak", state: "starting" as const },
      ]),
  };
  await runFungiCli(["computers", "--fungi-mcp", endpoint], io, {
    computersOwners: { list: owners.list },
  });
  expect(output).toContain("cedar (a): running");
  expect(output).toContain("birch (b): sleeping");
  expect(output).toContain("elm (c): queued #3");
  expect(output).toContain("oak (d): starting");
  output = "";
  await runFungiCli(
    ["computers", "start", "cedar", "--fungi-mcp", endpoint],
    io,
    {
      computersOwners: {
        start: (url, name, options) => {
          expect(url).toBe(endpoint);
          expect(name).toBe("cedar");
          options.onState({ state: "queued", position: 2 });
          options.onState({ state: "queued", position: 1 });
          options.onState({ state: "running" });
          return Promise.resolve({ computerId: "a", name: "cedar" });
        },
      },
    },
  );
  expect(output).toContain("cedar: queued #2");
  expect(output).toContain("cedar: queued #1");
  expect(output).toContain("cedar: running");
});

test("fungi computers rejects malformed command grammar", async () => {
  for (const argv of [
    ["computers", "start"],
    ["computers", "stop", "cedar"],
    ["computers", "extra"],
  ])
    await assert.rejects(runFungiCli(argv), /Usage: fungi computers/u);
});

test("fungi computers stops its wait on Ctrl-C and removes signal listeners", async () => {
  let output = "";
  const listeners = new Map<string, () => void>();
  await runFungiCli(
    [
      "computers",
      "start",
      "cedar",
      "--fungi-mcp",
      "https://hub.test/api/teams/team-1/mcp",
    ],
    {
      interactive: false,
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
      },
      signals: {
        on: (signal, listener) => {
          listeners.set(signal, listener);
        },
        off: (signal) => {
          listeners.delete(signal);
        },
      },
    },
    {
      computersOwners: {
        start: (_url, _name, options) => {
          listeners.get("SIGINT")?.();
          options.signal?.throwIfAborted();
          return Promise.reject(new Error("unreachable"));
        },
      },
    },
  );
  expect(listeners.size).toBe(0);
  expect(output).toContain("Stopped waiting");
  expect(output).not.toContain("cedar: running");
});

test("Fungi login accepts an explicit Hub and enrolls one account for models and MCP", async () => {
  const sink = capture();
  let selected: string | undefined;
  await runFungiCli(
    ["login", "--provider", "fungi", "--hub", "https://staging.fungi.computer"],
    { interactive: false, stdout: sink.stdout },
    {
      signInFungi: (issuer) => {
        selected = issuer;
        return Promise.resolve();
      },
    },
  );
  expect(selected).toBe("https://staging.fungi.computer/");
  expect(sink.text()).toContain("Fungi login complete");
});

test("bare login keeps the saved Hub and models payer under the shared Fungi account", async () => {
  let selected: string | undefined;
  const sink = capture();
  await runFungiCli(
    ["login"],
    { interactive: false, stdout: sink.stdout },
    {
      readFungiStatus: () =>
        Promise.resolve({
          issuer: "https://saved.test",
          accessExpiresAt: new Date(0),
        }),
      signInFungi: (issuer) => {
        selected = issuer;
        return Promise.resolve();
      },
      runAuth: () =>
        Promise.reject(new Error("must not fall back to another provider")),
    },
  );
  expect(selected).toBe("https://saved.test/");
});

test("Hub selection rejects foreign provider options and invalid origins before sign-in", async () => {
  let calls = 0;
  for (const argv of [
    ["login", "--provider", "anthropic", "--hub", "https://hub.test"],
    ["status", "--hub", "https://hub.test"],
    ["run", "hi", "--hub", "https://hub.test"],
    ["login", "--hub", "http://not-loopback.test"],
    ["login", "--hub", "https://hub.test/api/teams"],
    ["login", "--hub", "https://hub.test?secret=fixture"],
    ["login", "--hub", "https://user:fixture@hub.test"],
  ]) {
    await assert.rejects(
      runFungiCli(
        argv,
        { interactive: false },
        {
          signInFungi: () => {
            calls += 1;
            return Promise.resolve();
          },
        },
      ),
    );
  }
  expect(calls).toBe(0);
});

test("Fungi status prints selected paying Team metadata without checking remote authority", async () => {
  const sink = capture();
  await runFungiCli(
    ["status", "--provider", "fungi"],
    { stdout: sink.stdout },
    {
      runAuth: () => Promise.resolve(),
      readFungiStatus: () =>
        Promise.resolve({
          issuer: "https://hub.test",
          accessExpiresAt: new Date(0),
          team: { teamId: "team-1", name: "Garden", handle: "garden" },
          teamCount: 2,
        }),
    },
  );
  expect(sink.text()).toContain("Garden (garden)");
  expect(sink.text()).not.toContain("team-1");
  expect(sink.text()).not.toContain("token");
});

test("Fungi CLI login obeys the subscription kill switch before opening account enrollment", async () => {
  const saved = process.env.FUNGI_SUBSCRIPTION_KILL;
  process.env.FUNGI_SUBSCRIPTION_KILL = "fungi";
  let calls = 0;
  try {
    await assert.rejects(
      runFungiCli(
        ["login", "--provider", "fungi"],
        { interactive: false },
        {
          signInFungi: () => {
            calls += 1;
            return Promise.resolve();
          },
        },
      ),
      /Fungi models are paused/u,
    );
    expect(calls).toBe(0);
  } finally {
    if (saved === undefined) delete process.env.FUNGI_SUBSCRIPTION_KILL;
    else process.env.FUNGI_SUBSCRIPTION_KILL = saved;
  }
});

test("ACP dispatches the Local stdio owner before setup or terminal rendering", async () => {
  let root: string | undefined;
  let output = "";
  await runFungiCli(
    ["acp", "-C", "project"],
    {
      cwd: "/workspace",
      interactive: true,
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
      },
    },
    {
      runAcp: (options) => {
        root = options.invocationRoot;
        return Promise.resolve();
      },
      createRenderer: () =>
        Promise.reject(new Error("ACP must not mount the TUI")),
    },
  );
  expect(root).toBe("/workspace/project");
  expect(output).toBe("");
});

test("ACP rejects unrelated options and extra arguments before opening its door", async () => {
  for (const args of [
    ["--model", "wrong"],
    ["--yes"],
    ["--connect", "http://example.com"],
    ["unexpected"],
  ]) {
    await assert.rejects(
      runFungiCli(
        ["acp", ...args],
        {},
        {
          runAcp: () => Promise.reject(new Error("ACP must not open")),
        },
      ),
      /not valid with fungi acp|Usage: fungi acp/u,
    );
  }
});

test("ACP terminal authentication's appended login uses the ordinary login owner", async () => {
  let endpoint: string | undefined;
  await runFungiCli(
    [
      "acp",
      "login",
      "--provider",
      "fungi",
      "--hub",
      "https://staging.fungi.computer",
    ],
    {},
    {
      signInFungi: (received) => {
        endpoint = received;
        return Promise.resolve();
      },
      runAcp: () => Promise.reject(new Error("Login must not open ACP")),
    },
  );
  expect(endpoint).toBe("https://staging.fungi.computer/");
});

test("ACP help names stdio and the maintained login flow", async () => {
  let output = "";
  await runFungiCli(["acp", "--help"], {
    stdout: {
      write: (chunk) => {
        output += String(chunk);
        return true;
      },
    },
  });
  expect(output).toContain("stdin/stdout");
  expect(output).toContain("fungi acp login");
});

test("ACP login retains parsed options before the command, including a value named acp", async () => {
  let method: string | undefined;
  await runFungiCli(
    ["--method", "acp", "acp", "login", "--provider", "openai"],
    {},
    {
      runAuth: (_action, options) => {
        method = options?.method;
        return Promise.resolve();
      },
      runAcp: () => Promise.reject(new Error("Login must not open ACP")),
    },
  );
  expect(method).toBe("acp");
});

test("ACP terminal login accepts the editor's configured project root without passing it to login", async () => {
  for (const root of [["-C", "acp"], ["--cd=/workspace"]]) {
    let loggedIn = false;
    await runFungiCli(
      ["acp", ...root, "login", "--provider", "openai"],
      {
        stdout: { write: () => true },
      },
      {
        runAuth: (action) => {
          loggedIn = action === "login";
          return Promise.resolve();
        },
        runAcp: () => Promise.reject(new Error("Login must not open ACP")),
      },
    );
    expect(loggedIn).toBe(true);
  }
});

test("Git credential operations bypass banners and never echo supplied credentials", async () => {
  for (const action of ["store", "erase"]) {
    let output = "";
    await runFungiCli(
      [
        "git-credential",
        action,
        "--hub",
        "https://hub.test",
        "--team",
        "team-a",
      ],
      {
        interactive: true,
        stdin: Readable.from(["password=disposable-test-capability\n\n"]),
        stdout: {
          write(chunk) {
            output += String(chunk);
            return true;
          },
        },
      },
    );
    expect(output).toBe("");
  }
});
