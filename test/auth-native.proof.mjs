import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { log, error } from "node:console";
import { URL, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { act } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { renderTuiConversation } from "@fungi.computer/spore/frame-renderer";
import { createWhistle } from "@fungi.computer/whistle";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle/service";

// Real service, Local store, HTTP/RPC client and renderer. Only provider auth is
// injected; no credential store or inference request is used by this proof.
const localEntry = import.meta.resolve("@fungi.computer/truffle");
const { runPrivateLocalService } = await import(
  new URL("./private-local-service-listener.js", localEntry).href
);
const { serviceDirectory, readServiceRecord } = await import(
  new URL("./private-local-service-discovery.js", localEntry).href
);
const proofDist =
  process.env.TUI_PROOF_DIST ?? join(import.meta.dir, "../dist");
const { runTuiCli } = await import(
  pathToFileURL(join(proofDist, "cli-runtime.js")).href
);
const { noOpClientExtensions } = await import("./client-extension-fixture.mjs");
const root = await mkdtemp(join(tmpdir(), "fungi-auth-mounted-"));
const directory = await serviceDirectory(join(root, "service"));
const manager = createPrivateLocalServiceManager({ directory });
let behavior = "success";
let authCalls = 0;
let clientCloses = 0;
let rendererCreates = 0;
let setup;
let commands;
let running;
let promptArrived = Promise.withResolvers();
let authFinished = Promise.withResolvers();
let statusFinished = Promise.withResolvers();
const ready = Promise.withResolvers();
const mounted = Promise.withResolvers();
let loginRun;
const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const serviceRun = runPrivateLocalService(
  directory,
  undefined,
  undefined,
  async (args, options) => {
    // /login reads configured access first; that is a status call, not a sign-in.
    if (args[0] === "status") return { kind: "status", providers: [] };
    authCalls += 1;
    assert.equal(setup.renderer.isDestroyed, false);
    assert.equal(clientCloses, 0);
    if (behavior === "failure")
      throw new Error("synthetic-provider-detail-do-not-display");
    const answer = await options.interaction.prompt({
      type: "secret",
      message: "Synthetic provider secret",
    });
    assert.equal(answer, "synthetic-only");
    return { kind: "completed" };
  },
);
const bounded = async (operation, label) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded 10s`)),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
async function command(alias) {
  const row = commands.snapshot().slash.find((entry) => entry.alias === alias);
  assert.ok(row, `missing ${alias}`);
  await act(async () => commands.execute(row.commandId, { origin: "slash" }));
}
async function login() {
  const row = commands
    .snapshot()
    .slash.find((entry) => entry.alias === "login");
  assert.ok(row, "missing login");
  statusFinished = Promise.withResolvers();
  await act(() => {
    loginRun = commands.execute(row.commandId, { origin: "slash" });
  });
  // /login reads configured access over the Local door before it asks; frame
  // passes are not time, so wait for that round trip.
  await bounded(statusFinished.promise, "account status");
  await setup.waitForFrame((frame) =>
    frame.includes("Sign in to a model provider"),
  );
  await act(async () => setup.mockInput.typeText("OpenAI"));
  await act(async () => setup.mockInput.pressEnter());
  await setup.waitForFrame(
    (frame) =>
      frame.includes("How do you want to sign in to OpenAI?") &&
      frame.includes("OpenAI API key"),
  );
  await act(async () => setup.mockInput.pressEnter());
}
async function closeDialog() {
  await act(async () => setup.mockInput.pressArrow("down"));
  await act(async () => setup.mockInput.pressEnter());
  await setup.waitForFrame(
    (frame) => !frame.includes("Sign in to a model provider"),
  );
}
try {
  await Promise.race([
    (async () => {
      for (
        let attempt = 0;
        attempt < 100 && !(await readServiceRecord(directory));
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(await manager.status());
    })(),
    serviceRun.then(() => {
      throw new Error("Local proof service exited before it was ready");
    }),
  ]);
  const owner = await manager.connect({ invocationRoot: root });
  const selection = {
    invocationRoot: root,
    databasePath: owner.databasePath,
    sessionId: owner.sessionId,
  };
  await owner.close();
  running = runTuiCli(selection, {
    prepareClientExtensions: noOpClientExtensions,
    render: (root, queryClient, session, commands, onExit, theme, controls) => {
      renderTuiConversation(root, queryClient, {
        ...theme,
        commands,
        onExit,
        session,
        ...controls,
      });
      mounted.resolve();
    },
    createServiceManager: () => ({
      ...manager,
      auth: async (request, interaction) => {
        try {
          return await manager.auth(request, {
            ...interaction,
            prompt: (request) => {
              const answer = interaction.prompt(request);
              promptArrived.resolve();
              return answer;
            },
          });
        } finally {
          if (request.command === "status") statusFinished.resolve();
          else authFinished.resolve();
        }
      },
      connect: async (selection) => {
        const connection = await manager.connect(selection);
        return {
          ...connection,
          close: async () => {
            clientCloses += 1;
            await connection.close();
          },
        };
      },
    }),
    loadThemePreference: async () => ({ theme: "terminal" }),
    saveThemePreference: async () => undefined,
    createWhistle: () => {
      commands = createWhistle();
      return commands;
    },
    createRenderer: async (options) => {
      rendererCreates += 1;
      setup = await createTestRenderer({
        ...options,
        width: 76,
        height: 22,
        useKittyKeyboard: null,
      });
      ready.resolve();
      return setup.renderer;
    },
  });
  void running.catch((error) => ready.reject(error));
  log("auth proof: startup");
  await bounded(ready.promise, "TUI startup");
  await bounded(mounted.promise, "Session frame mounting");
  await act(async () => setup.renderOnce());
  await setup.waitForFrame((frame) => frame.includes("Start a conversation"));
  await act(async () => setup.mockInput.typeText("keep this draft"));
  log("auth proof: login", behavior);
  await login();
  await bounded(promptArrived.promise, "auth prompt arrival");
  await setup.waitForFrame((frame) =>
    frame.includes("Synthetic provider secret"),
  );
  await act(async () => setup.mockInput.typeText("synthetic-only"));
  await act(async () => setup.renderOnce());
  assert.equal(setup.captureCharFrame().includes("synthetic-only"), false);
  await act(async () => setup.mockInput.pressEnter());
  await bounded(authFinished.promise, "auth completion");
  await bounded(loginRun, "login completion");
  await setup.waitForFrame((frame) => frame.includes("keep this draft"));
  assert.equal(
    setup.captureCharFrame().includes("Signed in to OpenAI."),
    false,
  );
  assert.equal(authCalls, 1);

  behavior = "failure";
  authFinished = Promise.withResolvers();
  log("auth proof: login", behavior);
  await login();
  await bounded(authFinished.promise, "failed auth completion");
  await setup.waitForFrame((frame) =>
    frame.includes("Local authentication failed"),
  );
  assert.equal(
    setup.captureCharFrame().includes("synthetic-provider-detail"),
    false,
  );
  await bounded(loginRun, "failed login completion");
  await closeDialog();
  assert.ok(setup.captureCharFrame().includes("keep this draft"));

  behavior = "cancel";
  promptArrived = Promise.withResolvers();
  authFinished = Promise.withResolvers();
  log("auth proof: login", behavior);
  await login();
  await bounded(promptArrived.promise, "auth prompt arrival");
  await setup.waitForFrame((frame) =>
    frame.includes("Synthetic provider secret"),
  );
  await act(async () => setup.mockInput.pressEscape());
  await bounded(authFinished.promise, "cancelled auth completion");
  await bounded(loginRun, "cancelled login completion");
  await setup.waitForFrame(
    (frame) => !frame.includes("Sign in to a model provider"),
  );
  assert.ok(setup.captureCharFrame().includes("keep this draft"));
  assert.equal(setup.captureCharFrame().includes("History unavailable"), false);
  assert.equal(rendererCreates, 1);
  assert.equal(clientCloses, 0);
  assert.ok(await manager.status());
  log("auth proof: exit");
  await command("exit");
  await bounded(running, "TUI exit");
  assert.equal(clientCloses, 1);
  assert.equal(setup.renderer.isDestroyed, true);
  assert.ok(await manager.status());
  log(
    JSON.stringify({
      rendererCreates,
      authCalls,
      sameMountedClientDuringAuth: true,
      draftPreserved: true,
      secretNotRendered: true,
      serviceSurvivesClientExit: true,
    }),
  );
} catch (cause) {
  error("Native auth proof failed", cause);
  process.exitCode = 1;
} finally {
  try {
    if (setup && !setup.renderer.isDestroyed)
      await act(async () => setup.renderer.destroy());
    if (running) await bounded(running, "cleanup TUI");
  } finally {
    // fungi stop SIGTERMs the service; this listener shares the proof process.
    process.emit("SIGTERM", "SIGTERM");
    await serviceRun;
    await rm(root, { recursive: true, force: true });
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
}
