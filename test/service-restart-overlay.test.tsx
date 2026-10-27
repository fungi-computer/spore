import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "bun:test";
import { act } from "react";
import { TextareaRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle/service";
import * as Effect from "effect/Effect";
import { runTuiCli } from "../src/cli-runtime.js";
import { enterReactActEnvironment } from "./native-renderer-cleanup.js";

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

const nodes = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(nodes),
];
const composerText = (setup: Setup) =>
  nodes(setup.renderer.root)
    .filter((node) => node instanceof TextareaRenderable)
    .map((node) => node.plainText);
const occurrences = (text: string, needle: string) =>
  text.split(needle).length - 1;

/** A real Local service and the real TUI root; only the terminal is a test renderer. */
async function withOpenSession(
  run: (open: {
    setup: Setup;
    manager: ReturnType<typeof createPrivateLocalServiceManager>;
    firstBaseUrl: string;
    killService: () => Promise<void>;
    settle: (milliseconds: number) => Promise<void>;
    frame: () => string;
    until: (description: string, done: () => boolean) => Promise<void>;
    record: (name: string) => Promise<void>;
  }) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-restart-overlay-")),
  );
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".fungi"), { recursive: true, mode: 0o700 });
  await mkdir(project);
  const savedHome = process.env.HOME;
  const savedBuild = process.env.FUNGI_BUNDLED_BUILD_ID;
  process.env.HOME = home;
  process.env.FUNGI_BUNDLED_BUILD_ID = "a".repeat(64);
  const pidFile = join(root, "service.pid");
  const executable = join(root, "service-launch");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "echo $$ > " + JSON.stringify(pidFile),
      "exec " + JSON.stringify(process.execPath) + ' "$@"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const killService = async () => {
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, "SIGKILL");
  };
  const manager = createPrivateLocalServiceManager({
    executable,
    directory: join(home, ".fungi", "service"),
  });
  const commands = createWhistle();
  const ready = Promise.withResolvers<Setup>();
  let running: Promise<unknown> | undefined;
  const frames = process.env.TUI_RECONNECT_FRAMES;
  const restoreActEnvironment = enterReactActEnvironment();
  try {
    const owner = await manager.connect({ invocationRoot: project });
    await owner.session.send("Earlier message");
    const databasePath = owner.databasePath;
    const sessionId = owner.sessionId;
    const firstBaseUrl = owner.service.baseUrl;
    await owner.close();

    await act(async () => {
      running = runTuiCli(
        { invocationRoot: project, databasePath, sessionId },
        {
          loadThemePreference: () => Promise.resolve({ theme: "mocha" }),
          prepareClientExtensions: () =>
            Effect.succeed({
              entries: Effect.succeed([]),
              attach: () => Effect.void,
            }),
          createWhistle: () => commands,
          createServiceManager: () => manager,
          createRenderer: async () => {
            const created = await createTestRenderer({
              width: 100,
              height: 30,
              useKittyKeyboard: null,
            });
            ready.resolve(created);
            return created.renderer;
          },
          enableKeymap: true,
        },
      );
      await ready.promise;
    });
    const setup = await ready.promise;
    const settle = async (milliseconds: number) =>
      act(async () => {
        await delay(milliseconds);
        await setup.renderOnce();
      });
    const frame = () => setup.captureCharFrame();
    const until = async (description: string, done: () => boolean) => {
      const deadline = Date.now() + 30_000;
      while (!done()) {
        if (Date.now() > deadline)
          throw new Error(`Never saw ${description}:\n${frame()}`);
        await settle(50);
      }
    };
    const record = async (name: string) => {
      if (frames === undefined) return;
      await mkdir(frames, { recursive: true });
      await writeFile(join(frames, name), frame());
    };
    await until("the earlier message", () =>
      frame().includes("Earlier message"),
    );
    await until("the composer", () => composerText(setup).length === 1);
    await run({
      setup,
      manager,
      firstBaseUrl,
      killService,
      settle,
      frame,
      until,
      record,
    });
  } finally {
    try {
      const closing = running;
      if (closing !== undefined) {
        await act(async () => {
          await commands.execute("tui:exit", { origin: "slash" });
          await closing;
        });
      }
      commands.close();
      await manager.stop();
    } finally {
      restoreActEnvironment();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedBuild === undefined) delete process.env.FUNGI_BUNDLED_BUILD_ID;
      else process.env.FUNGI_BUNDLED_BUILD_ID = savedBuild;
      await rm(root, { recursive: true, force: true });
    }
  }
}

// The service is stopped (as `fungi stop` does) and started again on a new
// port while a Session is open.
for (const stop of ["graceful", "SIGKILL"]) {
  test(
    stop + " service restart resumes the Session with its draft",
    async () => {
      await withOpenSession(
        async ({
          setup,
          manager,
          firstBaseUrl,
          killService,
          settle,
          frame,
          until,
          record,
        }) => {
          await act(async () => setup.mockInput.typeText("my unsent draft"));
          await until(
            "the draft",
            () => composerText(setup)[0] === "my unsent draft",
          );
          await settle(100);
          expect(frame()).not.toContain("Restarting the service");
          await record("1-before-restart.txt");

          await act(async () => {
            if (stop === "SIGKILL") await killService();
            else await manager.stop();
          });
          // Exact timing belongs to the injected-clock tests, not this
          // process-level proof, whose stop can take longer under load.
          await until("the restart overlay", () =>
            frame().includes("Restarting the service"),
          );
          expect(frame()).toContain("Your conversation will resume.");
          await record("2-overlay.txt");

          // Still down a while later: still the overlay, still the draft.
          await settle(1_500);
          expect(frame()).toContain("Restarting the service");
          const second = await act(async () => manager.start());
          assert.notEqual(second.baseUrl, firstBaseUrl);
          await until(
            "the overlay to go away",
            () => !frame().includes("Restarting the service"),
          );
          await settle(300);
          expect(frame()).not.toContain("not answering");
          expect(composerText(setup)).toEqual(["my unsent draft"]);
          expect(occurrences(frame(), "Earlier message")).toBe(1);
          await record("3-after-resume.txt");

          // The resumed Session is live on the new service: the draft sends once.
          await act(async () => {
            setup.mockInput.pressEnter();
            await setup.renderOnce();
          });
          await until("the sent draft", () =>
            frame().includes("my unsent draft"),
          );
          await settle(500);
          expect(occurrences(frame(), "my unsent draft")).toBe(1);
          expect(occurrences(frame(), "Earlier message")).toBe(1);
          expect(composerText(setup)).toEqual([""]);
        },
      );
    },
    120_000,
  );
}
