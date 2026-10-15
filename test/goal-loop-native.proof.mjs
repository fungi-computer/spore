// Real CLI composition with a disposable Local service and a held faux reply.
import assert from "node:assert/strict";
import { runFungiCli } from "../dist/cli.js";
import { executeAlias } from "./command-selection.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { createPrivateModels } from "../../../runtimes/local/dist/local-models.js";
import { openPrivateLocalRuntimeHost } from "../../../runtimes/local/dist/private-local-runtime-host.js";
import { runPrivateLocalService } from "../../../runtimes/local/dist/private-local-service-listener.js";
import { createPrivateLocalServiceManager } from "../../../runtimes/local/dist/private-local-service.js";
import { serviceDirectory } from "../../../runtimes/local/dist/private-local-service-discovery.js";
import process from "node:process";
import { captureFrame } from "./frame-capture.ts";

const out =
  process.env.TUI_ORGANIZATION_CAPTURE_DIR ??
  join(process.cwd(), "../../.botanical/tui-organization/s0/real-after");
const [width, height] = (process.env.ORG_SIZE ?? "80x24")
  .split("x")
  .map(Number);
const suffix = `${width}x${height}`;
await mkdir(out, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "fungi-org-"));
const previousHome = process.env.HOME;
process.env.HOME = join(root, "home");
const directory = await serviceDirectory(join(root, "service"));
const models = createPrivateModels(join(root, "credentials.json"));
const faux = fauxProvider({ tokensPerSecond: 40 });
models.setProvider(faux.provider);
const pending = Promise.withResolvers();
faux.setResponses([
  async () => {
    await pending.promise;
    return fauxAssistantMessage("Done.");
  },
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
let setup;
let clientRun;
let selected;
const log = [];
const render = async (ms = 60) => {
  for (let i = 0; i < Math.max(1, Math.round(ms / 20)); i++)
    await act(async () => {
      await delay(20);
      await setup.renderOnce();
    });
};
const shot = async (name, ms = 120) => {
  await render(ms);
  await captureFrame(setup, out, `${name}-${suffix}`);
  log.push(name);
  process.stdout.write(`shot ${name}-${suffix}\n`);
};
const type = async (text) => {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });
  await render(80);
};
const enter = async () => {
  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await render(120);
};
const until = async (pred, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await render(40);
    if (pred(setup.captureCharFrame())) return true;
  }
  process.stdout.write(`timeout waiting\n${setup.captureCharFrame()}\n`);
  throw new Error("Expected real CLI frame did not arrive");
};
let failure;
try {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await manager.status()) !== undefined) break;
    await delay(25);
  }
  selected = await manager.connect({ invocationRoot: root, sessionId: "main" });
  const ready = Promise.withResolvers();
  await act(async () => {
    clientRun = runFungiCli(
      ["resume", "-C", root, "--db", selected.databasePath],
      { authModels: models, interactive: true },
      {
        loadThemePreference: () => Promise.resolve({ theme: "terminal" }),
        saveThemePreference: () => Promise.resolve(),
        createServiceManager: () => manager,
        createWhistle: () => commands,
        enableKeymap: true,
        createRenderer: async () => {
          setup = await createTestRenderer({
            width,
            height,
            useKittyKeyboard: null,
          });
          const ansi = [
            "#000000",
            "#cd3131",
            "#0dbc79",
            "#e5e510",
            "#2472c8",
            "#bc3fbc",
            "#11a8cd",
            "#e5e5e5",
            "#666666",
            "#f14c4c",
            "#23d18b",
            "#f5f543",
            "#3b8eea",
            "#d670d6",
            "#29b8db",
            "#ffffff",
          ];
          const colors = {
            palette: ansi,
            defaultForeground: "#cccccc",
            defaultBackground: "#1e1e1e",
            cursorColor: "#cccccc",
            mouseForeground: "#cccccc",
            mouseBackground: "#1e1e1e",
            tekForeground: "#cccccc",
            tekBackground: "#1e1e1e",
            highlightBackground: "#264f78",
            highlightForeground: "#ffffff",
          };
          setup.renderer.getPalette = async () => colors;
          ready.resolve();
          return setup.renderer;
        },
      },
    );
    await Promise.race([ready.promise, clientRun]);
  });
  await render(600);
  await shot("real-idle", 200);
  assert.doesNotMatch(setup.captureCharFrame(), /Goal ·|Loop ·/u);
  await type("/goal Keep the menus tidy");
  await enter();
  await until((frame) => frame.includes("Goal · active"));
  await type("/loop 10m check the menus");
  await enter();
  await until((frame) => frame.includes("Loop · active"));
  await shot("real-goal-loop-active", 200);
  const frame = setup.captureCharFrame();
  const status = frame
    .split("\n")
    .find((line) => /(?:● )?(?:waiting|thinking|streaming|idle)\s/u.test(line));
  assert.ok(status, "live status line visible");
  assert.doesNotMatch(status, /Goal active|Loop self/u);
  assert.match(status, /Enter send/u);
  assert.match(status, /Tab queue/u);
  assert.match(status, /Ctrl\+C cancel or exit/u);
  if (width >= 100) {
    assert.match(status, /PgUp\/PgDn scroll/u);
  }
  assert.equal(
    frame.split("\n").filter((line) => line.includes("Goal · active")).length,
    1,
  );
  assert.equal(
    frame.split("\n").filter((line) => line.includes("Loop · active")).length,
    1,
  );
} catch (cause) {
  failure = cause;
  if (failure && setup) globalThis.console.error(setup.captureCharFrame());
} finally {
  await writeFile(join(out, `shots-${suffix}.log`), log.join("\n"));
  pending.resolve();
  if (clientRun !== undefined && setup !== undefined) {
    await act(async () => {
      const result = await executeAlias(commands, "exit", {
        origin: "programmatic",
      });
      assert.equal(result.status, "handled");
      await Promise.race([clientRun, delay(3000)]);
    });
  }
  if (setup && !setup.renderer.isDestroyed) setup.renderer.destroy();
  await selected?.close();
  await manager.stop();
  await Promise.race([serviceRun, delay(3000)]);
  await rm(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
}
if (failure !== undefined) {
  globalThis.console.error(failure);
  process.exit(1);
}
process.exit(0);
