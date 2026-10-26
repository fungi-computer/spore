import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import {
  createPrivateCredentialStore,
  createPrivateModels,
  resolveDefaultCredentialPath,
} from "@fungi.computer/truffle";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle/service";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { createIsolatedCliEnvironment } from "./cli-test-isolation.js";
import * as Effect from "effect/Effect";
import { runFungiCli, type TuiAuthCall } from "../src/cli.js";
import { runTuiCli } from "../src/cli-runtime.js";
import { readLandingSummary } from "../src/landing-summary.js";
import type { TuiFrameControls } from "../src/tui-cli-contract.js";

async function fixture() {
  const area = await realpath(await mkdtemp(join(tmpdir(), "fungi-cli-root-")));
  const a = join(area, "a");
  const b = join(area, "b");
  const project = join(area, "project");
  await Promise.all([a, b, project].map((path) => mkdir(path)));
  const credentialPath = resolveDefaultCredentialPath(a);
  const otherPath = resolveDefaultCredentialPath(b);
  await createPrivateCredentialStore(credentialPath).modify("anthropic", () =>
    Promise.resolve({ type: "api_key", key: "synthetic-a" }),
  );
  await createPrivateCredentialStore(otherPath).modify("openai", () =>
    Promise.resolve({ type: "api_key", key: "synthetic-b" }),
  );
  return { area, a, b, project, credentialPath, otherPath };
}

function restoreHome(home: string | undefined) {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
}

async function withSelectedAppPane(
  issuer: string,
  visit: (
    apps: NonNullable<TuiFrameControls["apps"]>,
    selected: Awaited<ReturnType<typeof fixture>>,
  ) => Promise<void>,
) {
  const selected = await fixture();
  const previousHome = process.env.HOME;
  // The ordinary test runner owns process-start HOME. Bun's homedir keeps it.
  const ambient = createPrivateCredentialStore(
    resolveDefaultCredentialPath(homedir()),
  );
  const previousAccount = await ambient.read("fungi");
  const credential = (teamId: string) => ({
    type: "oauth",
    access: `synthetic-${teamId}`,
    refresh: "",
    expires: Date.now() + 3_600_000,
    issuer,
    team: { teamId, handle: teamId, name: teamId },
  });
  await createPrivateCredentialStore(selected.credentialPath).modify(
    "fungi",
    () => Promise.resolve({ ...credential("team-a"), type: "oauth" }),
  );
  await ambient.modify("fungi", () =>
    Promise.resolve({ ...credential("team-b"), type: "oauth" }),
  );
  const signals = new EventEmitter();
  const manager = createPrivateLocalServiceManager({ home: selected.a });
  const ready = Promise.withResolvers<NonNullable<TuiFrameControls["apps"]>>();
  let running: Promise<void> | undefined;
  try {
    process.env.HOME = selected.a;
    running = runTuiCli(
      { invocationRoot: selected.project, entry: "new" },
      {
        signals,
        enableKeymap: false,
        createRenderer: async () =>
          (
            await createTestRenderer({
              width: 80,
              height: 24,
              useKittyKeyboard: null,
            })
          ).renderer,
        loadThemePreference: () =>
          Promise.resolve({ theme: "mocha", sigils: "off" }),
        prepareClientExtensions: () =>
          Effect.succeed({
            entries: Effect.succeed([]),
            attach: () => Effect.void,
          }),
        render: (
          _root,
          _query,
          _session,
          _commands,
          _exit,
          _theme,
          controls,
        ) => {
          if (controls.apps === undefined)
            ready.reject(new Error("The selected Session has no App pane"));
          else ready.resolve(controls.apps);
        },
        renderRecovery: (_root, error) => {
          ready.reject(error);
        },
      },
      selected.a,
    );
    process.env.HOME = homedir();
    await visit(
      await Promise.race([
        ready.promise,
        running.then(() => {
          throw new Error(
            "Terminal closed before opening the selected Session",
          );
        }),
      ]),
      selected,
    );
  } finally {
    signals.emit("SIGTERM");
    try {
      await running;
    } finally {
      await manager.stop();
      if (previousAccount === undefined) await ambient.delete("fungi");
      else
        await ambient.modify("fungi", () => Promise.resolve(previousAccount));
      restoreHome(previousHome);
      await rm(selected.area, { recursive: true, force: true });
    }
  }
}

test("the selected Session's Apps sign-in check stays with A after the terminal await", async () => {
  await withSelectedAppPane("https://hub.invalid", async (apps, selected) => {
    expect(await apps.signedIn(new AbortController().signal)).toBe(true);
    const credentials = createPrivateCredentialStore(selected.credentialPath);
    await credentials.delete("fungi");
    expect(await credentials.read("fungi")).toBeUndefined();
    // B is still signed in; A's sign-out must not silently select B.
    expect(await apps.signedIn(new AbortController().signal)).toBe(false);
  });
}, 30_000);

test("the selected Session opens Apps lazily with A's Team and token, not B's", async () => {
  const requests: { path: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      });
      return Response.json({ actorIsTeamOwner: false, apps: [], roles: {} });
    },
  });
  try {
    await withSelectedAppPane(server.url.origin, async (apps) => {
      expect(await apps.read(new AbortController().signal)).toEqual({
        actorIsTeamOwner: false,
        apps: [],
        roles: {},
      });
      expect(requests).toEqual([
        {
          path: "/api/teams/team-a/local/apps",
          authorization: "Bearer synthetic-team-a",
        },
      ]);
    });
  } finally {
    await server.stop(true);
  }
}, 30_000);

for (const drift of [false, true]) {
  test(`serve retains explicit A with ambient B (change across CLI await: ${String(drift)})`, async () => {
    const selected = await fixture();
    const previousHome = process.env.HOME;
    const ambientHome = homedir();
    const manifest = join(
      ambientHome,
      ".fungi",
      "extensions",
      "installed.json",
    );
    const original = (await Bun.file(manifest).exists())
      ? await Bun.file(manifest).text()
      : undefined;
    const poison = "{not valid JSON";
    await mkdir(join(ambientHome, ".fungi", "extensions"), { recursive: true });
    await writeFile(manifest, poison);
    const workers = join(selected.area, "workers.json");
    await writeFile(
      workers,
      JSON.stringify([
        {
          name: "selected",
          owner: { invocationRoot: selected.project },
        },
      ]),
    );
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 404 }),
    });
    const listen = reservation.url.origin;
    await reservation.stop(true);
    const signals = new EventEmitter();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      signals.emit("SIGTERM");
    });
    let running: Promise<void> | undefined;
    try {
      process.env.HOME = drift ? selected.a : ambientHome;
      running = runFungiCli(
        ["serve", "--workers", workers, "--listen", listen],
        {
          cwd: selected.project,
          signals,
          stdout: output,
        },
        {},
        selected.a,
      );
      if (drift) process.env.HOME = ambientHome;
      await running;
      expect(Buffer.concat(chunks).toString("utf8")).toContain(
        '"status":"ready"',
      );
      expect(await readFile(manifest, "utf8")).toBe(poison);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      signals.emit("SIGTERM");
      try {
        await running;
      } finally {
        if (original === undefined) await rm(manifest, { force: true });
        else await writeFile(manifest, original);
        output.destroy();
        restoreHome(previousHome);
        await rm(selected.area, { recursive: true, force: true });
      }
    }
  }, 30_000);
}

test("the deferred landing summary reads the selected account, not ambient HOME", async () => {
  const fixture_ = await fixture();
  const previousHome = process.env.HOME;
  try {
    for (const { path, name } of [
      { path: fixture_.credentialPath, name: "Team A" },
      { path: fixture_.otherPath, name: "Team B" },
    ]) {
      await createPrivateCredentialStore(path).modify("fungi", () =>
        Promise.resolve({
          type: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 60_000,
          issuer: "https://hub.invalid",
          team: { teamId: name, handle: "fixture", name },
        }),
      );
    }
    const beforeB = await readFile(fixture_.otherPath, "utf8");
    process.env.HOME = fixture_.b;
    const summary = await readLandingSummary(
      createModels(),
      [
        { databasePath: join(fixture_.project, "first.sqlite") },
        { databasePath: join(fixture_.project, "second.sqlite") },
      ],
      new AbortController().signal,
      { credentialPath: fixture_.credentialPath },
    );
    expect(summary).toEqual({ account: "Fungi · Team A", model: undefined });
    expect(await readFile(fixture_.otherPath, "utf8")).toBe(beforeB);
  } finally {
    restoreHome(previousHome);
    await rm(fixture_.area, { recursive: true, force: true });
  }
});

for (const injected of [false, true]) {
  test(`login retains its entry-selected home through the picker await (injected Models: ${String(injected)})`, async () => {
    const fixture_ = await fixture();
    const previousHome = process.env.HOME;
    const input = new PassThrough();
    const signals = new EventEmitter();
    const models = createPrivateModels(fixture_.credentialPath);
    const beforeB = await readFile(fixture_.otherPath, "utf8");
    let picked = false;
    let auth: TuiAuthCall | undefined;
    try {
      process.env.HOME = fixture_.a;
      const running = runFungiCli(
        ["login", "--auth-type", "api_key"],
        {
          interactive: true,
          stdin: input,
          signals,
          authModels: injected ? models : undefined,
          stdout: {
            write(chunk) {
              const text = stripVTControlCharacters(chunk.toString());
              if (!picked && text.includes("More providers")) {
                picked = true;
                queueMicrotask(() => input.write("anthropic\r"));
              }
              return true;
            },
          },
        },
        {
          runAuth: (_action, options) => {
            auth = options;
            return Promise.resolve();
          },
        },
        fixture_.a,
      );
      process.env.HOME = fixture_.b;
      await running;
      expect(picked).toBe(true);
      expect(auth?.credentialPath).toBe(fixture_.credentialPath);
      expect(await auth?.models?.checkAuth("anthropic")).toMatchObject({
        type: "api_key",
      });
      if (injected) expect(auth?.models).toBe(models);
      expect(await readFile(fixture_.otherPath, "utf8")).toBe(beforeB);
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      input.end();
      restoreHome(previousHome);
      await rm(fixture_.area, { recursive: true, force: true });
    }
  });
}

async function terminalOpeningRetainsHome(
  fixture_: Awaited<ReturnType<typeof fixture>>,
  stopError?: Error,
) {
  const previousHome = process.env.HOME;
  const managerA = createPrivateLocalServiceManager({ home: fixture_.a });
  const managerB = createPrivateLocalServiceManager({ home: fixture_.b });
  if (stopError !== undefined) {
    const stopA = managerA.stop.bind(managerA);
    const stop = spyOn(managerA, "stop");
    stop.mockImplementation(async () => {
      stop.mockRestore();
      // Release the real fixture service, then reproduce a rejected stop.
      // No process or module mock may stand in for the teardown path.
      await stopA();
      throw stopError;
    });
  }
  const commands = createWhistle();
  const interaction = createWhistleInteractionHost({ title: "Extensions" });
  const presenter = commands.present(() => interaction.begin());
  const signals = new EventEmitter();
  const ready = Promise.withResolvers<undefined>();
  const invalid = "{not valid JSON";
  const manifestB = join(fixture_.b, ".fungi", "extensions", "installed.json");
  await mkdir(join(fixture_.b, ".fungi", "extensions"), { recursive: true });
  await writeFile(manifestB, invalid);
  let running: Promise<void> | undefined;
  let sequence = -1;
  const unsubscribe = interaction.subscribe(() => {
    const snapshot = interaction.snapshot();
    if (snapshot.retryable) interaction.cancel();
    const prompt = snapshot.prompt;
    if (prompt === undefined || prompt.sequence === sequence) return;
    sequence = prompt.sequence;
    interaction.answer(prompt.sequence, "list");
  });
  try {
    process.env.HOME = fixture_.a;
    running = runTuiCli(
      { invocationRoot: fixture_.project, entry: "landing" },
      {
        signals,
        enableKeymap: false,
        createWhistle: () => commands,
        createRenderer: async () =>
          (
            await createTestRenderer({
              width: 80,
              height: 24,
              useKittyKeyboard: null,
            })
          ).renderer,
        loadThemePreference: () =>
          Promise.resolve({ theme: "mocha", sigils: "off" }),
        prepareClientExtensions: () =>
          Effect.succeed({
            entries: Effect.succeed([]),
            attach: () => Effect.void,
          }),
        renderLanding: () => {
          ready.resolve(undefined);
        },
        renderRecovery: (_root, error) => {
          ready.reject(error);
        },
      },
      fixture_.a,
    );
    process.env.HOME = fixture_.b;
    await ready.promise;
    expect(await managerA.status()).toBeDefined();
    expect(await managerB.status()).toBeUndefined();
    expect(
      (await commands.execute("local:extensions", { origin: "slash" })).status,
    ).toBe("handled");
    expect(await readFile(manifestB, "utf8")).toBe(invalid);
  } finally {
    signals.emit("SIGTERM");
    try {
      await running;
    } finally {
      unsubscribe();
      presenter();
      try {
        await managerA.stop();
        await managerB.stop();
      } finally {
        restoreHome(previousHome);
        await rm(fixture_.area, { recursive: true, force: true });
      }
    }
  }
}

test("terminal opening retains the default service home and deferred extension owner", async () => {
  await terminalOpeningRetainsHome(await fixture());
}, 30_000);

test("a rejected terminal stop restores HOME before the next CLI subprocess", async () => {
  const fixture_ = await fixture();
  const isolated = await createIsolatedCliEnvironment();
  const previousHome = process.env.HOME;
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "fungi-next-cli-")));
  const nextHome = isolated.home;
  const stopError = new Error("synthetic service stop rejection");
  try {
    process.env.HOME = nextHome;
    await assert.rejects(
      terminalOpeningRetainsHome(fixture_, stopError),
      (cause: unknown) => cause === stopError,
    );
    // Match cli-grammar's real executable caller: no explicit HOME override.
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/cli.tsx", import.meta.url).pathname,
        "run",
        "hello",
      ],
      {
        cwd,
        env: isolated.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [stderr] = await Promise.all([
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect({
      home: process.env.HOME,
      fixtureRetained: await Bun.file(
        join(fixture_.b, ".fungi", "extensions", "installed.json"),
      ).exists(),
      exitCode: await child.exited,
    }).toMatchObject({
      home: nextHome,
      fixtureRetained: false,
      exitCode: 1,
    });
    expect(stderr).toContain(
      "fungi: No signed-in model provider is available.",
    );
    expect(stderr).not.toContain("Local service selection failed");
  } finally {
    // The regression must not itself poison the suite when run against RED.
    restoreHome(previousHome);
    try {
      await Promise.all([
        createPrivateLocalServiceManager({ home: fixture_.b }).stop(),
        createPrivateLocalServiceManager({ home: nextHome }).stop(),
      ]);
    } finally {
      await Promise.all([
        rm(fixture_.area, { recursive: true, force: true }),
        rm(cwd, { recursive: true, force: true }),
        isolated.cleanup(),
      ]);
    }
  }
}, 30_000);
