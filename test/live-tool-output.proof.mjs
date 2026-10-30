import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { runTuiCli } from "../dist/cli-runtime.js";
import { createPrivateModels } from "../../../runtimes/local/dist/local-models.js";
import { openPrivateLocalRuntimeHost } from "../../../runtimes/local/dist/private-local-runtime-host.js";
import { runPrivateLocalService } from "../../../runtimes/local/dist/private-local-service-listener.js";
import { createPrivateLocalServiceManager } from "../../../runtimes/local/dist/private-local-service.js";
import { serviceDirectory } from "../../../runtimes/local/dist/private-local-service-discovery.js";
import { captureFrame } from "./frame-capture.ts";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { waitForFrame } from "./native-readiness.js";

// AFTER of the Oct 18 BEFORE capture: real Local service, Pi faux, no model call.
// The short scratch/HOME keeps the service socket under the Unix pathname limit.
const root = await mkdtemp(join(tmpdir(), "fungi-live-"));
const project = join(root, "project");
await mkdir(project);
const shots = process.env.TUI_LIVE_OUTPUT_CAPTURE_DIR;
const previousHome = process.env.HOME;
process.env.HOME = join(root, "home");
const directory = await serviceDirectory(join(root, "service"));
const models = createPrivateModels(join(root, "credentials.json"));
const faux = fauxProvider();
models.setProvider(faux.provider);
const command =
  'for i in $(seq 1 12); do echo "build step $i/12: compiling module_$i"; echo "warn $i" >&2; sleep 1; done; echo done';
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("execute", {
      code: `return await env.computers.local.exec({command:${JSON.stringify(command)},timeoutMs:60000});`,
    }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("The build finished."),
]);
const manager = createPrivateLocalServiceManager({
  directory,
  executionPath: `${dirname(process.execPath)}:/usr/bin:/bin`,
});
const serviceRun = runPrivateLocalService(
  directory,
  (input) =>
    openPrivateLocalRuntimeHost(
      {
        ...input,
        providerId: faux.getModel().provider,
        modelId: faux.getModel().id,
      },
      models,
    ),
  () => Promise.resolve([]),
);
const commands = createWhistle();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let selected;
let setup;
let clientRun;
try {
  if (shots) await mkdir(shots, { recursive: true });
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await manager.status()) !== undefined) break;
    await delay(25);
  }
  assert.ok(await manager.status(), "disposable service did not start");
  selected = await manager.connect({
    invocationRoot: project,
    sessionId: "main",
  });
  const ready = Promise.withResolvers();
  await act(async () => {
    clientRun = runTuiCli(
      {
        invocationRoot: project,
        databasePath: selected.databasePath,
        sessionId: "main",
      },
      {
        loadThemePreference: () => Promise.resolve({ theme: "terminal" }),
        prepareClientExtensions: noOpClientExtensions,
        createServiceManager: () => manager,
        createWhistle: () => commands,
        enableKeymap: true,
        createRenderer: async () => {
          setup = await createTestRenderer({
            width: 110,
            height: 32,
            useKittyKeyboard: null,
          });
          ready.resolve();
          return setup.renderer;
        },
      },
    );
    await Promise.race([ready.promise, clientRun]);
  });
  await selected.session.send("Run the 12 second build.", {
    requestId: "build",
  });
  await waitForFrame(setup, (frame) => frame.includes("Running script"));
  const started = Date.now();
  const observations = [];
  for (const at of [3, 6, 9]) {
    while (Date.now() - started < at * 1000) {
      await act(async () => {
        await delay(50);
        await setup.renderOnce();
      });
    }
    const frame = setup.captureCharFrame();
    assert.match(frame, /Running script/u);
    assert.match(
      frame,
      new RegExp(`^ +build step ${at}/12: compiling module_${at}`, "mu"),
    );
    assert.match(frame, new RegExp(`^ +warn ${at} *$`, "mu"));
    assert.equal((frame.match(/^ +(?:build step|warn) /gmu) ?? []).length, 6);
    observations.push({
      atSeconds: at,
      elapsedMs: Date.now() - started,
      running: true,
    });
    await captureFrame(
      setup,
      shots,
      `after-running-${String(at).padStart(2, "0")}s`,
    );
  }
  let snapshot;
  for (let attempt = 0; attempt < 300; attempt++) {
    snapshot = await selected.session.read();
    if (snapshot.terminals.length > 0) break;
    await act(async () => {
      await delay(50);
      await setup.renderOnce();
    });
  }
  assert.equal(snapshot?.terminals[0]?.outcome, "completed");
  await waitForFrame(setup, (frame) => frame.includes("The build finished."));
  const final = setup.captureCharFrame();
  assert.match(final, /Ran script.*● ▸/u);
  assert.doesNotMatch(final, /^ +(?:build step|warn) /mu);
  assert.doesNotMatch(final, /Running script/u);
  await captureFrame(setup, shots, "after-finished");
  if (shots)
    await writeFile(
      join(shots, "after-observations.json"),
      JSON.stringify(
        {
          command,
          observations,
          finalFolded: true,
          model: "deterministic Pi faux; no live model call",
        },
        null,
        2,
      ),
    );
  process.stdout.write(
    "Live Local stdout/stderr visible at 3/6/9s; final result folded.\n",
  );
} catch (cause) {
  if (setup) process.stderr.write(`${setup.captureCharFrame()}\n`);
  throw cause;
} finally {
  try {
    if (clientRun !== undefined)
      await act(async () => {
        await commands.execute(
          { namespace: "tui", id: "exit" },
          { origin: "slash" },
        );
        await clientRun;
      });
    if (setup && !setup.renderer.isDestroyed) setup.renderer.destroy();
    await selected?.close();
    // This proof embeds the listener; the maintained stop client must not kill
    // its own process. Use the listener's ordinary signal lifecycle, as its
    // in-process service tests do.
    process.emit("SIGTERM", "SIGTERM");
    await serviceRun;
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}
