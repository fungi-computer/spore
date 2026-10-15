import { executeAlias } from "./command-selection.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { act } from "react";
import { CodeRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";
import { runTuiCli } from "@fungi.computer/tui/cli-runtime";

function nodes(node) {
  return [node, ...node.getChildren().flatMap(nodes)];
}

/** Real service/read/watch; only observation failure and model completion are controlled. */
export async function proveServiceRecovery({
  manager,
  root,
  owner,
  started,
  release,
}) {
  const failedObservation = Promise.withResolvers();
  const secondFailure = Promise.withResolvers();
  const commands = createWhistle();
  const mounted = Promise.withResolvers();
  const watchReady = Promise.withResolvers();
  const watchClosed = Promise.withResolvers();
  let setup;
  let watchCloses = 0;
  let watchAttempts = 0;
  let running;
  let selected;
  async function capture(state) {
    const directory = process.env.TUI_PROOF_FRAME_DIR;
    if (directory === undefined) return;
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `service-${state}.txt`),
      setup.captureCharFrame(),
    );
  }
  try {
    await owner.session.command({
      type: "prompt",
      requestId: randomUUID(),
      text: "Hold recovery work",
      delivery: "steer",
    });
    await started;
    const concurrentQueueTexts = [
      "Concurrent queued work A",
      "Concurrent queued work B",
    ];
    await Promise.all(
      concurrentQueueTexts.map((text) =>
        owner.session.command({
          type: "prompt",
          requestId: randomUUID(),
          text,
          delivery: "followUp",
        }),
      ),
    );
    const queuedBeforeEdit = (await owner.session.read()).pending.prompts;
    assert.deepEqual(
      queuedBeforeEdit.map((prompt) => prompt.text).sort(),
      concurrentQueueTexts.sort(),
      "concurrent prompts are both accepted by the durable owner",
    );
    const queuedFirst = queuedBeforeEdit[0];
    const lastQueued = queuedBeforeEdit.at(-1);
    assert.ok(queuedFirst && lastQueued);
    selected = await manager.connect({
      invocationRoot: root,
      databasePath: owner.databasePath,
      sessionId: owner.sessionId,
    });
    const session = {
      ...selected.session,
      watch: async () => {
        const attempt = ++watchAttempts;
        if (attempt === 3) throw new Error("Controlled reconnect failure");
        const watch = await selected.session.watch();
        const iterator = watch.changes[Symbol.asyncIterator]();
        watchReady.resolve();
        return {
          ...watch,
          changes: {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                attempt === 1
                  ? Promise.race([iterator.next(), failedObservation.promise])
                  : Promise.race([iterator.next(), secondFailure.promise]),
              return: () =>
                iterator.return?.() ??
                Promise.resolve({ done: true, value: undefined }),
            }),
          },
          close: async () => {
            watchCloses += 1;
            await watch.close();
            watchClosed.resolve();
          },
        };
      },
    };
    running = runTuiCli(
      {
        invocationRoot: root,
        databasePath: owner.databasePath,
        sessionId: owner.sessionId,
      },
      {
        prepareClientExtensions: noOpClientExtensions,
        createServiceManager: () => ({
          ...manager,
          connect: async () => ({ ...selected, session }),
        }),
        createWhistle: () => commands,
        loadThemePreference: async () => ({ theme: "mocha" }),
        enableKeymap: true,
        createRenderer: async (options) => {
          setup = await createTestRenderer({
            ...options,
            width: 90,
            height: 22,
            useKittyKeyboard: null,
          });
          mounted.resolve();
          return setup.renderer;
        },
      },
    );
    await mounted.promise;
    await act(async () => {
      await setup.renderOnce();
    });
    await Promise.race([
      watchReady.promise,
      running.then(() => {
        throw new Error("Client exited before observation opened");
      }),
    ]);
    await act(async () => {
      await setup.renderOnce();
    });
    await setup.waitForFrame(
      (frame) =>
        frame.includes("Prove the installed client.") &&
        frame.includes("Hold recovery work"),
    );
    const markdown = nodes(setup.renderer.root).filter(
      (node) => node instanceof TextRenderable,
    );
    assert.ok(
      markdown.some((node) => node.plainText.includes("INSTALLED_CLI_OK")),
      "retained assistant reaches native styled text",
    );
    await Promise.all(
      nodes(setup.renderer.root)
        .filter((node) => node instanceof CodeRenderable)
        .map((node) => node.highlightingDone),
    );
    await act(async () => {
      await setup.renderOnce();
    });
    assert.match(
      setup.captureCharFrame(),
      /INSTALLED_CLI_OK/,
      "assistant renders after native highlighting completes",
    );
    assert.notEqual(
      (await owner.session.read()).activity.queue.state,
      "idle",
      "real work remains held",
    );
    const queueNotices = [];
    const queueInteraction = {
      signal: new globalThis.AbortController().signal,
      prompt: () => Promise.reject(new Error("Queue commands do not prompt")),
      notify: (notice) => queueNotices.push(notice.message),
    };
    const runQueueCommand = (action) =>
      executeAlias(commands, "queue", {
        origin: "agent",
        arguments: { action },
        interaction: queueInteraction,
      });
    assert.equal((await runQueueCommand("list")).status, "handled");
    assert.match(
      queueNotices[0],
      new RegExp(`queued · accepted: ${queuedFirst.text}`),
    );
    assert.match(
      queueNotices[0],
      new RegExp(`queued · accepted: ${lastQueued.text}`),
    );
    assert.equal((await runQueueCommand("editLast")).status, "handled");
    await setup.waitForFrame((frame) => frame.includes(lastQueued.text));
    assert.match(
      queueNotices.at(-1),
      /Queued prompt returned to the composer for editing/u,
    );
    release();
    let settledSnapshot;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      settledSnapshot = await owner.session.read();
      if (
        settledSnapshot.terminals?.some(
          (terminal) =>
            terminal.commandId === lastQueued.commandId &&
            terminal.outcome === "cancelled",
        )
      )
        break;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
    }
    assert.ok(
      settledSnapshot?.terminals?.some(
        (terminal) =>
          terminal.commandId === lastQueued.commandId &&
          terminal.outcome === "cancelled",
      ),
      "Watchdog settles the owner-accepted withdrawal after the active run",
    );
    assert.ok(
      settledSnapshot.terminals?.some(
        (terminal) =>
          terminal.commandId === queuedFirst.commandId &&
          terminal.outcome === "completed",
      ),
      "the earlier accepted prompt completes before the withdrawn last prompt",
    );
    assert.deepEqual(settledSnapshot.pending.prompts, []);
    await capture("live");
    const reconnectNotices = [];
    const reconnectInteraction = {
      signal: new globalThis.AbortController().signal,
      prompt: () => Promise.reject(new Error("Reconnect does not prompt")),
      notify: (notice) => reconnectNotices.push(notice.message),
    };
    assert.deepEqual(
      (
        await executeAlias(commands, "reconnect", {
          origin: "slash",
          interaction: reconnectInteraction,
        })
      ).result,
      { kind: "nothing_to_reconnect", state: "connected" },
    );
    assert.equal(watchAttempts, 1);
    await act(async () => {
      failedObservation.reject(new Error("Controlled observation failure"));
    });
    await watchClosed.promise;
    await act(async () => {
      await setup.renderOnce();
    });
    // Read the full cause at a width that fits the owner-resolved model label,
    // then restore the ordinary terminal width for reconnect checks.
    setup.resize(140, 22);
    await setup.waitForFrame((frame) =>
      frame.includes("disconnected: Controlled observation"),
    );
    setup.resize(90, 22);
    assert.deepEqual(
      (
        await executeAlias(commands, "reconnect", {
          origin: "slash",
          interaction: reconnectInteraction,
        })
      ).result,
      { kind: "reconnected" },
    );
    assert.equal(watchAttempts, 2);
    assert.deepEqual(reconnectNotices, [
      "Session history is already connected.",
      "Session history reconnected.",
    ]);
    setup.resize(140, 22);
    await setup.waitForFrame((frame) => frame.includes("● idle"));
    secondFailure.reject(new Error("Controlled second observation failure"));
    await setup.waitForFrame((frame) =>
      frame.includes("disconnected: Controlled second"),
    );
    setup.resize(90, 22);
    assert.deepEqual(
      (
        await executeAlias(commands, "reconnect", {
          origin: "slash",
          interaction: reconnectInteraction,
        })
      ).result,
      { kind: "failed", cause: "Controlled reconnect failure" },
    );
    assert.equal(watchAttempts, 3);
    assert.equal(
      reconnectNotices.at(-1),
      "Reconnect failed: Controlled reconnect failure. Check the connection, then try /reconnect again.",
    );
    await setup.waitForFrame(
      (frame) =>
        frame.includes("Prove the installed client.") &&
        frame.includes("INSTALLED_CLI_OK"),
    );
    assert.match(
      setup.captureCharFrame(),
      /Prove the installed client\./,
      "history remains visible after observation fails",
    );
    assert.match(
      setup.captureCharFrame(),
      /INSTALLED_CLI_OK/,
      "assistant remains visible after observation fails",
    );
    await capture("unavailable");
    await act(async () => {
      setup.mockInput.pressKey("c", { ctrl: true });
      await running;
    });
    assert.equal(setup.renderer.isDestroyed, true);
    assert.equal(watchCloses, 2);
    assert.ok(await manager.status(), "client exit preserves the real service");
    assert.equal(
      (await owner.session.read()).activity.queue.state,
      "idle",
      "client exit preserves the settled durable Session",
    );
    const reopened = await manager.connect({
      invocationRoot: root,
      databasePath: owner.databasePath,
      sessionId: owner.sessionId,
    });
    try {
      assert.equal(reopened.sessionId, owner.sessionId);
      assert.deepEqual(
        (await reopened.session.read()).pending.prompts.map(
          (prompt) => prompt.text,
        ),
        [],
        "the owner queue remains settled after reopening the durable Session",
      );
      assert.ok(
        (await reopened.session.read()).terminals?.some(
          (terminal) =>
            terminal.commandId === lastQueued.commandId &&
            terminal.outcome === "cancelled",
        ),
        "the withdrawn prompt outcome survives reopening the durable Session",
      );
      assert.ok(
        (await reopened.session.read()).messages.some(
          ({ value }) => value.role === "assistant",
        ),
      );
    } finally {
      await reopened.close();
    }
  } finally {
    release();
    if (running !== undefined) {
      if (!setup?.renderer.isDestroyed)
        await commands.execute("tui:exit", { origin: "slash" });
      await running;
    } else await selected?.close();
  }
}
