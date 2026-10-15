import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const drainQueue = process.env.TUI_CANCEL_DRAIN === "1";
const foreground = process.env.TUI_CANCEL_FOREGROUND === "1";
const cancelKey = process.env.TUI_CANCEL_KEY === "ctrl-c" ? "ctrl-c" : "esc";
const root = await mkdtemp(join(tmpdir(), "fungi-cancel-wait-"));
const previousHome = process.env.HOME;
process.env.HOME = join(root, "home");
const directory = await serviceDirectory(join(root, "service"));
const models = createPrivateModels(join(root, "credentials.json"));
const faux = fauxProvider();
models.setProvider(faux.provider);
const waitResponse = (marker) =>
  fauxAssistantMessage(
    fauxToolCall("execute", {
      code: foreground
        ? `return await Local_Computer.exec({command:"echo $$ > ${marker}.pid; touch ${marker}; exec sleep 60",timeoutMs:60000});`
        : `const started = await Local_Computer.exec({operation:"start",command:"touch ${marker}; sleep 60"}); return await Local_Computer.exec({operation:"wait",id:started.process.id,timeoutMs:60000});`,
    }),
    { stopReason: "toolUse" },
  );
faux.setResponses([
  waitResponse("wait-started"),
  // Keep the follow-ups pending while Esc drains them. Instant faux replies
  // could finish between decoded keys, before a person can withdraw them.
  ...(drainQueue ? [waitResponse("blocker-started")] : []),
  ...Array.from({ length: 3 }, () =>
    fauxAssistantMessage("Queued prompt delivered."),
  ),
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
let blocker;
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
                  if (command.type === "abort")
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
  const foregroundPid = foreground
    ? Number(await readFile(join(root, "wait-started.pid"), "utf8"))
    : undefined;
  if (foreground) {
    assert.ok(Number.isSafeInteger(foregroundPid) && foregroundPid > 0);
    process.kill(foregroundPid, 0);
  }
  if (drainQueue) {
    blocker = await manager.createSession({
      invocationRoot: root,
      databasePath: selected.databasePath,
      requestId: "queue-blocker",
    });
    await blocker.session.send("Keep the follow-ups pending for this proof.", {
      requestId: "blocker",
    });
  }
  const queued = await selected.session.send("Deliver this after Stop.", {
    requestId: "queued",
    delivery: "followUp",
  });
  const pending = [queued];
  if (drainQueue) {
    for (const requestId of ["queued-2", "queued-3"])
      pending.push(
        await selected.session.send(requestId, {
          requestId,
          delivery: "followUp",
        }),
      );
  }
  if (drainQueue)
    await waitForFrame(setup, (frame) => frame.includes("Queued · queued-3"));
  await act(async () => {
    await setup.renderOnce();
    await captureFrame(
      setup,
      process.env.TUI_CANCEL_SHOTS,
      foreground
        ? `foreground-before-${cancelKey}`
        : drainQueue
          ? "drain-before-esc"
          : "wait-before-esc",
    );
  });
  // Observe each physical key through the shared native input helper. Rendering
  // between keys reflects the same command-state updates the real host sees.
  const cancellationRequestedAt = performance.now();
  for (let press = 0; press < (drainQueue ? 4 : 1); press += 1)
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
    assert.throws(() => process.kill(foregroundPid, 0), { code: "ESRCH" });
  }
  const stoppedAt = performance.now();
  if (blocker !== undefined) {
    // The first Esc interrupts the main wait; the blocker owns the next turn.
    // Release it only after all physical Esc presses, then observe settlement.
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await readFile(join(root, "blocker-started"));
        break;
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
        await delay(25);
      }
    }
    await readFile(join(root, "blocker-started"));
    await blocker.session.abort();
  }
  let snapshot;
  for (let attempt = 0; attempt < 100; attempt++) {
    snapshot = await selected.session.read();
    if (
      pending.every((entry) =>
        snapshot.terminals.some(
          (terminal) =>
            terminal.commandId === entry.commandId &&
            terminal.outcome === (drainQueue ? "cancelled" : "completed"),
        ),
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
    foreground
      ? `foreground-after-${cancelKey}`
      : drainQueue
        ? "drain-after-esc"
        : "wait-after-esc",
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
    pending.every((entry) =>
      snapshot.terminals.some(
        (terminal) =>
          terminal.commandId === entry.commandId &&
          terminal.outcome === (drainQueue ? "cancelled" : "completed"),
      ),
    ),
    drainQueue
      ? "Repeated Esc did not drain all pending messages"
      : "queued prompt did not resume",
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
      queuedDelivered: !drainQueue,
      queuedCancelled: drainQueue ? pending.length : 0,
      model: "deterministic Pi faux; no live model call",
    }),
  );
} catch (cause) {
  failure = cause;
  if (setup) globalThis.console.error(setup.captureCharFrame());
} finally {
  if (clientRun !== undefined) {
    await act(async () => {
      await commands.execute("tui:exit", { origin: "slash" });
      await clientRun;
    });
  }
  if (setup && !setup.renderer.isDestroyed) setup.renderer.destroy();
  await blocker?.session.abort();
  await blocker?.close();
  await selected?.close();
  await manager.stop();
  await serviceRun;
  try {
    await rm(root, { recursive: true, force: true });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}
if (failure !== undefined) throw failure;
