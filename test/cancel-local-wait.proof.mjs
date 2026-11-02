import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import process from "node:process";
import { performance } from "node:perf_hooks";
import { captureFrame } from "./frame-capture.ts";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

// An independent service, store, native renderer and real workerd/Computer wait.
// Only model responses are controlled; no live provider or shared service is used.
const foreground = process.env.TUI_CANCEL_FOREGROUND === "1";
const cancelKey = process.env.TUI_CANCEL_KEY === "ctrl-c" ? "ctrl-c" : "esc";
const root = await mkdtemp(join(tmpdir(), "fungi-cancel-wait-"));
const previousHome = process.env.HOME;
process.env.HOME = join(root, "home");
const directory = await serviceDirectory(join(root, "service"));
const models = createPrivateModels(join(root, "credentials.json"));
const faux = fauxProvider();
models.setProvider(faux.provider);
// The sandbox gives the command its own PID namespace, so the host finds the
// foreground sleep by its unique argument in /proc instead of by a guest PID.
const foregroundSleep = `60.${process.pid}`;
const foregroundSleeps = async () => {
  const found = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    let argv;
    try {
      argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
    } catch (cause) {
      if (cause.code === "ENOENT" || cause.code === "ESRCH") continue;
      throw cause;
    }
    if (argv.includes(foregroundSleep)) found.push(entry);
  }
  return found;
};
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("execute", {
      code: foreground
        ? `return await env.computers.local.exec({command:"touch wait-started; exec sleep ${foregroundSleep}",timeoutMs:60000});`
        : `const started = await env.computers.local.exec({operation:"start",command:"touch wait-started; sleep 60"}); return await env.computers.local.exec({operation:"wait",id:started.process.id,timeoutMs:60000});`,
    }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("Queued prompt delivered."),
]);
const manager = createPrivateLocalServiceManager({ directory });
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
let failure;
let cancellationAcknowledgedAt;
try {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await manager.status()) !== undefined) break;
    await delay(25);
  }
  assert.ok(await manager.status(), "disposable service did not start");
  selected = await manager.connect({ invocationRoot: root, sessionId: "main" });
  const ready = Promise.withResolvers();
  await act(async () => {
    clientRun = runTuiCli(
      {
        invocationRoot: root,
        databasePath: selected.databasePath,
        sessionId: "main",
      },
      {
        loadThemePreference: () => Promise.resolve({ theme: "terminal" }),
        prepareClientExtensions: noOpClientExtensions,
        createServiceManager: () => ({
          ...manager,
          connect: async (options) => {
            const connected = await manager.connect(options);
            return {
              ...connected,
              session: {
                ...connected.session,
                command: async (command) => {
                  const receipt = await connected.session.command(command);
                  // Esc stops the current turn with a cancel command; queued
                  // withdrawals carry onlyIfPending and are not the stop.
                  if (command.type === "cancel" && !command.onlyIfPending)
                    cancellationAcknowledgedAt = performance.now();
                  return receipt;
                },
              },
            };
          },
        }),
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
  const first = await selected.session.send(
    "Wait for the background command.",
    {
      requestId: "wait",
    },
  );
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await readFile(join(root, "wait-started"));
      break;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
      await delay(25);
    }
  }
  await readFile(join(root, "wait-started"));
  await waitForFrame(setup, (frame) => frame.includes("Running script"));
  if (foreground) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await foregroundSleeps()).length > 0) break;
      await delay(25);
    }
    assert.equal(
      (await foregroundSleeps()).length,
      1,
      "the foreground command is running before cancellation",
    );
  }
  const queued = await selected.session.send("Deliver this after Stop.", {
    requestId: "queued",
    delivery: "followUp",
  });
  await act(async () => {
    await setup.renderOnce();
    await captureFrame(
      setup,
      process.env.TUI_CANCEL_SHOTS,
      foreground ? `foreground-before-${cancelKey}` : "wait-before-esc",
    );
  });
  // Observe the physical key through the shared native input helper. Rendering
  // after it reflects the same command-state updates the real host sees.
  const cancellationRequestedAt = performance.now();
  await pressDecodedKey(setup, () =>
    cancelKey === "ctrl-c"
      ? setup.mockInput.pressKey("c", { ctrl: true })
      : setup.mockInput.pressEscape(),
  );
  let cancelledSnapshot;
  while (performance.now() - cancellationRequestedAt < 1_000) {
    cancelledSnapshot = await selected.session.read();
    if (
      cancellationAcknowledgedAt !== undefined &&
      cancelledSnapshot.terminals.some(
        (terminal) =>
          terminal.commandId === first.commandId &&
          terminal.outcome === "cancelled",
      )
    )
      break;
    await delay(5);
  }
  const cancellationSettledMs = performance.now() - cancellationRequestedAt;
  assert.ok(
    cancellationAcknowledgedAt !== undefined,
    "TUI cancel was not acknowledged",
  );
  const cancellationAcknowledgedMs =
    cancellationAcknowledgedAt - cancellationRequestedAt;
  assert.ok(
    cancellationAcknowledgedMs < 1_000,
    "TUI cancel acknowledgement exceeded 1 s",
  );
  assert.ok(
    cancellationSettledMs < 1_000 &&
      cancelledSnapshot.terminals.some(
        (terminal) =>
          terminal.commandId === first.commandId &&
          terminal.outcome === "cancelled",
      ),
    "Service did not abort and settle the long-running tool in under 1 s",
  );
  if (foreground) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await foregroundSleeps()).length === 0) break;
      await delay(25);
    }
    assert.deepEqual(
      await foregroundSleeps(),
      [],
      "cancellation ends the foreground command",
    );
  }
  const stoppedAt = performance.now();
  let snapshot;
  for (let attempt = 0; attempt < 100; attempt++) {
    snapshot = await selected.session.read();
    if (
      snapshot.terminals.some(
        (terminal) =>
          terminal.commandId === queued.commandId &&
          terminal.outcome === "completed",
      )
    )
      break;
    await act(async () => {
      await setup.renderOnce();
      await delay(50);
    });
  }
  await act(async () => setup.renderOnce());
  await captureFrame(
    setup,
    process.env.TUI_CANCEL_SHOTS,
    foreground ? `foreground-after-${cancelKey}` : "wait-after-esc",
  );
  assert.ok(
    snapshot.terminals.some(
      (terminal) =>
        terminal.commandId === first.commandId &&
        terminal.outcome === "cancelled",
    ),
    "Esc did not cancel the long wait",
  );
  assert.ok(
    snapshot.terminals.some(
      (terminal) =>
        terminal.commandId === queued.commandId &&
        terminal.outcome === "completed",
    ),
    "queued prompt did not resume",
  );
  assert.doesNotMatch(
    setup.captureCharFrame(),
    /Cancellation could not reach the session/u,
  );
  globalThis.console.log(
    JSON.stringify({
      cancellationAndDeliveryMs: performance.now() - stoppedAt,
      cancellationAcknowledgedMs,
      cancellationSettledMs,
      foregroundProcessAborted: foreground,
      cancelKey,
      cancelled: true,
      queuedDelivered: true,
      model: "deterministic Pi faux; no live model call",
    }),
  );
} catch (cause) {
  failure = cause;
  if (setup) globalThis.console.error(setup.captureCharFrame());
} finally {
  if (clientRun !== undefined) {
    await act(async () => {
      await commands.execute(
        { namespace: "tui", id: "exit" },
        { origin: "slash" },
      );
      await clientRun;
    });
  }
  if (setup && !setup.renderer.isDestroyed) setup.renderer.destroy();
  await selected?.close();
  // fungi stop SIGTERMs the service; this listener shares the proof process.
  process.emit("SIGTERM", "SIGTERM");
  await serviceRun;
  try {
    await rm(root, { recursive: true, force: true });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}
if (failure !== undefined) throw failure;
