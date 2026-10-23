// Goal states through the real CLI, a disposable Local service and a faux model:
// one worded footer line, Esc/closing pause the goal, finished goals become
// chat lines, and the replace prompt appears only for a live or paused goal.
import assert from "node:assert/strict";
import { runTuiCli } from "../dist/cli-runtime.js";
import { executeAlias } from "./command-selection.js";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import goalClient from "@fungi.computer/shiitake-extensions/goal/client";
import { createPrivateModels } from "../../../runtimes/local/dist/local-models.js";
import { openPrivateLocalRuntimeHost } from "../../../runtimes/local/dist/private-local-runtime-host.js";
import { runPrivateLocalService } from "../../../runtimes/local/dist/private-local-service-listener.js";
import { createPrivateLocalServiceManager } from "../../../runtimes/local/dist/private-local-service.js";
import { serviceDirectory } from "../../../runtimes/local/dist/private-local-service-discovery.js";
import { captureFrame } from "./frame-capture.ts";

/** Optional text captures, named to pair with the goal audit's before shots. */
const out = process.env.GOAL_STATES_CAPTURE_DIR;
const [width, height] = [100, 30];
if (out !== undefined) await mkdir(out, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "fungi-goal-states-"));
const previousHome = process.env.HOME;
process.env.HOME = join(root, "home");
const directory = await serviceDirectory(join(root, "service"));
const models = createPrivateModels(join(root, "credentials.json"));
const faux = fauxProvider({ tokensPerSecond: 400 });
models.setProvider(faux.provider);
/** A model reply that waits until the proof releases it. */
const held = () => {
  let release = () => undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = false;
  return {
    reply: async () => {
      started = true;
      await gate;
      return fauxAssistantMessage("late reply");
    },
    started: () => started,
    release: () => release(),
  };
};
const tool = (code) =>
  fauxAssistantMessage(fauxToolCall("execute", { code }), {
    stopReason: "toolUse",
  });
const first = held();
const last = held();
const resumed = held();
faux.setResponses([
  first.reply,
  fauxAssistantMessage("Pizza sounds good."),
  tool(
    'async () => await goal.update_goal({status:"complete", reason:"Menus are tidy and verified"})',
  ),
  fauxAssistantMessage("The menus are tidy."),
  tool(
    'async () => await goal.update_goal({status:"blocked", reason:"No access to the release repo"})',
  ),
  fauxAssistantMessage("I am blocked on repo access."),
  fauxAssistantMessage("Working on the icons."),
  fauxAssistantMessage("Still thinking about icons."),
  fauxAssistantMessage("Icons, icons."),
  fauxAssistantMessage("More icon thoughts."),
  last.reply,
  fauxAssistantMessage("Recovered reply."),
  fauxAssistantMessage("Spare reply."),
  fauxAssistantMessage("Spare reply."),
  fauxAssistantMessage("Spare reply."),
  fauxAssistantMessage("Spare reply."),
  fauxAssistantMessage("Spare reply."),
  fauxAssistantMessage("Spare reply."),
]);
const startService = () => ({
  manager: createPrivateLocalServiceManager({ directory }),
  run: runPrivateLocalService(
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
  ),
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const palette = {
  palette: [
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
  ],
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
let service = startService();
let commands;
let setup;
let clientRun;
let selected;
const render = async (ms = 60) => {
  for (let i = 0; i < Math.max(1, Math.round(ms / 20)); i++)
    await act(async () => {
      await delay(20);
      await setup.renderOnce();
    });
};
const frame = () => setup.captureCharFrame();
const shot = async (name, ms = 300) => {
  await render(ms);
  await captureFrame(setup, out, name);
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
  await render(160);
};
const escape = async () => {
  await act(async () => {
    setup.mockInput.pressEscape();
  });
  await render(200);
};
const until = async (what, predicate, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await render(40);
    if (predicate(frame())) return;
  }
  throw new Error("Timed out waiting for " + what + "\n" + frame());
};
/** A closed slash prompt leaves its command text as the draft; clear it. */
const clearDraft = async () => {
  for (let i = 0; i < 64 && !frame().includes("Ask anything"); i++)
    await act(async () => {
      setup.mockInput.pressBackspace();
    });
  await until("an empty composer", (text) => text.includes("Ask anything"));
};
/** The pinned rows under the composer: the status line, then goal rows. */
const footer = () => frame().split("\n").slice(-6).join("\n");
const lines = (text) =>
  frame()
    .split("\n")
    .filter((line) => line.includes(text));
const open = async () => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await service.manager.status()) !== undefined) break;
    await delay(25);
  }
  selected = await service.manager.connect({
    invocationRoot: root,
    sessionId: "main",
  });
  commands = createWhistle();
  const ready = Promise.withResolvers();
  await act(async () => {
    clientRun = runTuiCli(
      {
        invocationRoot: root,
        databasePath: selected.databasePath,
        sessionId: "main",
        clients: [goalClient],
      },
      {
        loadThemePreference: () => Promise.resolve({ theme: "terminal" }),
        createServiceManager: () => service.manager,
        createWhistle: () => commands,
        enableKeymap: true,
        createRenderer: async () => {
          setup = await createTestRenderer({
            width,
            height,
            useKittyKeyboard: null,
          });
          // A known palette keeps the "palette unavailable" notice out of the frame.
          setup.renderer.getPalette = async () => palette;
          ready.resolve();
          return setup.renderer;
        },
      },
    );
    await Promise.race([ready.promise, clientRun]);
  });
  await render(600);
};
/** Close the client and stop the Local service, as quitting the app does. */
const close = async () => {
  await act(async () => {
    const result = await executeAlias(commands, "exit", {
      origin: "programmatic",
    });
    assert.equal(result.status, "handled");
    await Promise.race([clientRun, delay(3000)]);
  });
  if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  await selected.close();
  await service.manager.stop();
  await Promise.race([service.run, delay(3000)]);
};
let failure;
try {
  await open();
  await shot("00-idle");

  // R2: a live goal is one worded line.
  await type("/goal Tidy the menus");
  await enter();
  await until("the live goal line", (text) =>
    /Pursuing goal since \d\d:\d\d · Tidy the menus/u.test(text),
  );
  await shot("01-goal-set-agent-working");
  assert.equal(lines("Pursuing goal since").length, 1);
  assert.doesNotMatch(frame(), /Goal · |Goal active/u);

  // R1: Esc pauses the goal.
  await until("the goal work to start", () => first.started());
  await escape();
  first.release();
  await until("the paused goal line", (text) =>
    text.includes("Goal paused (/goal resume) · Tidy the menus · Stopped"),
  );
  await shot("02-after-esc-goal-still-active");
  assert.doesNotMatch(footer(), /Pursuing goal/u);

  await type("/goal");
  await enter();
  await until("the paused goal menu", (text) => text.includes("Resume goal"));
  await shot("03-goal-menu-after-esc");
  assert.match(frame(), /Goal paused: Tidy the menus \(Stopped\)/u);
  assert.doesNotMatch(frame(), /Pause goal/u);
  await escape();
  await until("the menu to close", (text) => !text.includes("Resume goal"));
  await clearDraft();

  // R1: an unrelated question does not restart a paused goal.
  await type("what should we eat for lunch?");
  await enter();
  await until("the lunch answer", (text) =>
    text.includes("Pizza sounds good."),
  );
  await shot("04-lunch-question-restarted-old-goal", 1500);
  assert.match(footer(), /Goal paused \(\/goal resume\) · Tidy the menus/u);
  assert.doesNotMatch(frame(), /The menus are tidy\./u);

  // R3: an achieved goal leaves the footer and posts one chat line.
  await type("/goal resume");
  await enter();
  await until("the achieved chat line", (text) =>
    text.includes("Goal achieved · Tidy the menus"),
  );
  await shot("04b-resumed-goal-achieved", 600);
  assert.equal(lines("Goal achieved").length, 1);
  assert.doesNotMatch(footer(), /Pursuing goal|Goal paused/u);
  // R5: goal turns never show in the chat; only the status lines do.
  assert.doesNotMatch(frame(), /Goal turn ·/u);

  // R7: no replace prompt after a finished goal. R4: blocked pauses.
  await type("/goal Write the release notes");
  await enter();
  await until("the blocked goal to pause", (text) =>
    text.includes("Blocked: No access to the release repo"),
  );
  await shot("05-second-goal-blocked", 600);
  assert.doesNotMatch(frame(), /Replace the/u);
  assert.match(
    footer(),
    /Goal paused \(\/goal resume\) · Write the release notes · Blocked/u,
  );

  // R7: a paused (blocked) goal is current, so replacing it asks first.
  await type("/goal Plan the next sprint");
  await enter();
  await until("the replace prompt", (text) =>
    text.includes("Replace the paused goal?"),
  );
  await shot("06-replace-prompt-for-blocked-goal");
  await escape();
  await until("the kept goal", (text) => !text.includes("Replace the paused"));
  await shot("07-after-keep-current-goal", 400);
  assert.match(
    footer(),
    /Goal paused \(\/goal resume\) · Write the release notes/u,
  );

  // R3: a cleared goal leaves the footer and posts one chat line.
  await clearDraft();
  await type("/goal clear");
  await enter();
  await until("the cleared chat line", (text) =>
    text.includes("Goal cleared · Write the release notes"),
  );
  await shot("08-after-goal-clear", 600);
  assert.equal(lines("Goal cleared").length, 1);
  assert.doesNotMatch(footer(), /Pursuing goal|Goal paused/u);

  // A stall pauses with its reason; replacing a paused goal asks first.
  await type("/goal Polish the icons");
  await enter();
  await until("the stalled goal", (text) => text.includes("Stalled"));
  await shot("09-stalled-goal-auto-paused", 600);
  assert.match(footer(), /Goal paused \(\/goal resume\) · Polish the icons/u);
  await type("/goal Ship the icons");
  await enter();
  await until("the replace prompt", (text) =>
    text.includes("Replace the paused goal?"),
  );
  await shot("10-replace-prompt-for-auto-paused-goal");
  await escape();
  await until("the kept goal", (text) => !text.includes("Replace the paused"));
  await clearDraft();

  // R1 + R6: a runtime restart mid goal turn resumes that turn, so the goal
  // stays live and reopening asks nothing.
  await type("/goal resume");
  await enter();
  await until("the resumed goal work", () => last.started());
  await until("the live goal line", (text) =>
    /Pursuing goal since \d\d:\d\d · Polish the icons/u.test(text),
  );
  await shot("11-live-goal-before-closing");
  // Process loss: keep the store exactly as committed mid goal turn. A
  // graceful stop waits for the turn, so release it, stop, then restore.
  const store = selected.databasePath;
  const lost = join(root, "lost-mid-goal.sqlite");
  const reader = new Database(store, { readonly: true });
  reader.run("VACUUM INTO ?", [lost]);
  reader.close();
  last.release();
  await close();
  await rm(`${store}-wal`, { force: true });
  await rm(`${store}-shm`, { force: true });
  await copyFile(lost, store);
  // The restored turn resumes and finishes; the goal's next turn then waits.
  faux.setResponses([
    fauxAssistantMessage("Resumed the icons."),
    resumed.reply,
    fauxAssistantMessage("Spare reply."),
    fauxAssistantMessage("Spare reply."),
    fauxAssistantMessage("Spare reply."),
  ]);
  service = startService();
  await open();
  await until("the resumed turn", (text) =>
    text.includes("Resumed the icons."),
  );
  await until("the goal's next turn", () => resumed.started());
  await shot("12-reopened-after-closing-mid-goal", 600);
  assert.match(footer(), /Pursuing goal since \d\d:\d\d · Polish the icons/u);
  assert.doesNotMatch(frame(), /Replace the|Resume paused goal\?/u);
  assert.doesNotMatch(footer(), /Goal paused/u);
  resumed.release();
  await close();
} catch (cause) {
  failure = cause;
} finally {
  first.release();
  last.release();
  resumed.release();
  await rm(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
}
if (failure !== undefined) {
  globalThis.console.error(failure);
  process.exit(1);
}
process.stdout.write("goal-states-native: pass\n");
process.exit(0);
