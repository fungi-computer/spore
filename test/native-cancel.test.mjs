import assert from "node:assert/strict";
import process from "node:process";
import { clearTimeout, setImmediate, setTimeout } from "node:timers";
import { test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  defaultScheduler,
  notifyManager,
  QueryObserver,
} from "@tanstack/query-core";
import { sessionQueryOptions } from "@fungi.computer/parakeet/headless";
import {
  idleActivity,
  runningActivity,
} from "@fungi.computer/parakeet-testing";
import { runTuiCli } from "@fungi.computer/spore/cli-runtime";
import { createTuiFixture } from "./fixture.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { captureFrame } from "./frame-capture.ts";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

for (const deferredNotifications of [false, true]) {
  test.each(["success", "transport rejection", "refusal", "discovery failure"])(
    `Escape and /stop all summarize %s once, outside the settled footer${deferredNotifications ? " with deferred Query notifications" : ""}`,
    async (outcome) => {
      const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      const fixture = createTuiFixture();
      const setup = await createTestRenderer({
        width: 96,
        height: 24,
        useKittyKeyboard: null,
      });
      const commands = createWhistle();
      const queryClient = createQueryClient();
      const session = {
        ...fixture.session,
        modelPreference: {
          read: async () => null,
          set: async () => undefined,
        },
      };
      const initial = Promise.withResolvers();
      const streaming = Promise.withResolvers();
      const settled = [Promise.withResolvers(), Promise.withResolvers()];
      const followUp = Promise.withResolvers();
      const observer = new QueryObserver(queryClient, {
        ...sessionQueryOptions(session),
        enabled: false,
      });
      // Observe the same notification queue as React, not a synchronous cache
      // write or the native renderer's unrelated visual-idle signal.
      const unsubscribe = observer.subscribe(
        notifyManager.batchCalls((result) => {
          const snapshot = result.data?.snapshot;
          if (result.data?.observation === "live" && snapshot !== undefined)
            initial.resolve();
          if (snapshot?.progress?.text === "Fixture is streaming a reply.")
            streaming.resolve();
          for (const [index, notification] of settled.entries())
            if (snapshot?.cursor === `fixture-settled-${index + 1}`)
              notification.resolve();
          if (
            snapshot?.activity.queue.state === "running" &&
            snapshot.activity.queue.commandId === "follow-up-run"
          )
            followUp.resolve();
        }),
      );
      const renderAfter = async (notification) => {
        let timeout;
        try {
          await act(async () => {
            await Promise.race([
              notification.promise,
              new Promise((_, reject) => {
                // Existing external-event bound; no extra render passes or retries.
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Expected Session Query notification was not delivered",
                      ),
                    ),
                  2000,
                );
              }),
            ]);
            await setup.renderOnce();
          });
        } finally {
          clearTimeout(timeout);
        }
      };
      const ready = Promise.withResolvers();
      let cascades = 0;
      let running;
      const serviceGate = Promise.withResolvers();
      const settle = () =>
        fixture.pushFrame({
          kind: "update",
          delivery: "live",
          cursor: `fixture-settled-${String(cascades)}`,
          messages: [],
          terminals: [],
          pending: { total: 0, prompts: [], hasMore: false },
          extensions: {},
          attention: [],
          activity: idleActivity,
        });
      try {
        await act(async () => {
          running = runTuiCli(
            { invocationRoot: "/fixture", sessionId: "tui-fixture" },
            {
              loadThemePreference: async () => ({ theme: "terminal" }),
              createQueryClient: () => queryClient,
              prepareClientExtensions: noOpClientExtensions,
              createServiceManager: () => ({
                connect: async () => ({
                  sandboxStatus: async () => ({
                    state: "available",
                    requireSandbox: false,
                  }),
                  agentId: "agent-fixture",
                  databasePath: "/fixture/agent.sqlite",
                  sessionId: "tui-fixture",
                  session,
                  stopAll: async () => {
                    cascades++;
                    if (cascades === 1) await serviceGate.promise;
                    settle();
                    if (outcome === "transport rejection")
                      throw new Error("Stop transport unavailable");
                    if (outcome === "refusal")
                      throw new Error(
                        "The selected Agent could not be read; no cascade was started",
                      );
                    return {
                      rootAgentId: "agent-fixture",
                      agents: [
                        {
                          agentId: "helper",
                          name: "Helper",
                          outcome: "stopped",
                        },
                        {
                          agentId: "agent-fixture",
                          name: "Shiitake",
                          outcome: "idle",
                        },
                      ],
                      discoveryFailures:
                        outcome === "discovery failure"
                          ? [
                              {
                                agentId: "unreadable-helper",
                                reason: "Store unreadable",
                              },
                            ]
                          : [],
                    };
                  },
                  close: async () => undefined,
                }),
                models: async () => [],
              }),
              createWhistle: () => commands,
              enableKeymap: true,
              createRenderer: async () => {
                ready.resolve();
                return setup.renderer;
              },
            },
          );
          await Promise.race([ready.promise, running]);
        });
        await renderAfter(initial);
        assert.match(setup.captureCharFrame(), /Start a conversation\./u);
        const notifications = [];
        if (deferredNotifications)
          notifyManager.setScheduler((callback) =>
            notifications.push(callback),
          );
        await act(async () => {
          await fixture.session.command({
            type: "prompt",
            requestId: "running-test",
            delivery: "followUp",
            text: "Keep working until cancelled",
          });
          fixture.confirmLatestPrompt();
          await setup.renderOnce();
        });
        if (deferredNotifications) {
          await setup.waitForVisualIdle();
          assert.ok(notifications.length > 0);
          setImmediate(() => {
            notifyManager.setScheduler(defaultScheduler);
            for (const notify of notifications) notify();
          });
        }
        await renderAfter(streaming);
        assert.match(
          setup.captureCharFrame(),
          /Fixture is streaming a reply\./u,
        );
        await captureFrame(setup, process.env.STOP_ALL_FRAMES, "before");
        await pressDecodedKey(setup, () => setup.mockInput.pressEscape());
        assert.deepEqual(fixture.cancelCalls(), [
          { type: "cancel", commandId: "owner-running-test" },
        ]);
        assert.equal(fixture.abortCalls(), 0);
        assert.equal(cascades, 0);
        const afterFirstPress = setup.captureCharFrame();
        await pressDecodedKey(setup, () => setup.mockInput.pressEscape());
        assert.deepEqual(fixture.cancelCalls(), [
          { type: "cancel", commandId: "owner-running-test" },
        ]);
        assert.equal(fixture.abortCalls(), 0);
        assert.match(afterFirstPress, /cancelling…/u);
        assert.equal(cascades, 1);
        // Neither the pending cascade nor its eventual warning may own composer input.
        await act(async () => {
          setup.mockInput.typeText("/stop all");
        });
        await waitForFrame(setup, (frame) => frame.includes("/stop all"));
        serviceGate.resolve();
        await renderAfter(settled[0]);
        const summary =
          outcome === "transport rejection" || outcome === "refusal"
            ? "Stop-all unconfirmed"
            : outcome === "discovery failure"
              ? "confirmed: unreadable-helper"
              : "Stopped 1 helper";
        // The service reply and its observation stream are independent transports.
        // Await the actual idle observation, not an arbitrary scheduling delay.
        const after = await waitForFrame(
          setup,
          (frame) =>
            frame.includes(summary) &&
            frame.includes("● idle") &&
            !frame.includes("cancelling…"),
        );
        assert.match(after, new RegExp(summary));
        assert.equal(
          after.split(summary).length - 1,
          1,
          "exactly one summary toast",
        );
        const toastBorder = setup
          .captureSpans()
          .lines[1]?.spans.find((span) => span.text.includes("│"));
        assert.deepEqual(
          toastBorder?.fg.toInts(),
          RGBA.fromIndex(outcome === "success" ? 2 : 3).toInts(),
          "service and discovery failures use the warning toast variant",
        );
        assert.doesNotMatch(
          after,
          /Cancellation could not reach|resume later|cancelling…|\+\d+ more/u,
        );
        // Bottom composer/footer region stays clear of cancellation and summary content.
        assert.doesNotMatch(
          after.split("\n").slice(-5).join("\n"),
          /Stopped|unconfirmed|not confirmed|cancelling/u,
        );
        await captureFrame(
          setup,
          process.env.STOP_ALL_FRAMES,
          `after-${outcome.replaceAll(" ", "-")}`,
        );
        // Dismissing once must exhaust the first invocation's notifications.
        await act(async () => {
          await setup.mockMouse.click(91, 1);
        });
        await waitForFrame(setup, (frame) => !frame.includes(summary));
        assert.doesNotMatch(setup.captureCharFrame(), new RegExp(summary));
        await pressDecodedKey(setup, () => setup.mockInput.pressEnter());
        await renderAfter(settled[1]);
        assert.equal(cascades, 2);
        await waitForFrame(setup, (frame) => frame.includes(summary));
        assert.match(setup.captureCharFrame(), new RegExp(summary));
        assert.doesNotMatch(
          setup.captureCharFrame(),
          /Cancellation could not reach|resume later|cancelling…|\+\d+ more/u,
        );
        assert.equal(setup.captureCharFrame().split(summary).length - 1, 1);
        await act(async () => {
          await setup.mockMouse.click(91, 1);
        });
        await waitForFrame(setup, (frame) => !frame.includes(summary));
        assert.doesNotMatch(setup.captureCharFrame(), new RegExp(summary));
        await act(async () => {
          fixture.pushFrame({
            kind: "update",
            delivery: "live",
            cursor: "fixture-follow-up",
            messages: [],
            terminals: [],
            pending: { total: 0, prompts: [], hasMore: false },
            extensions: {},
            attention: [],
            activity: runningActivity({
              queue: { state: "running", commandId: "follow-up-run" },
            }),
          });
        });
        await renderAfter(followUp);
        assert.doesNotMatch(setup.captureCharFrame(), /cancelling…/u);
        for (let press = 0; press < 2; press++) {
          await act(async () => {
            setup.mockInput.typeText("/cancel");
          });
          await waitForFrame(setup, (frame) => frame.includes("/cancel"));
          await pressDecodedKey(setup, () => setup.mockInput.pressEnter());
          assert.deepEqual(
            fixture.cancelCalls(),
            [
              { type: "cancel", commandId: "owner-running-test" },
              { type: "cancel", commandId: "follow-up-run" },
            ],
            "Enter must cancel the new run once",
          );
          assert.equal(fixture.abortCalls(), 0);
        }
      } finally {
        notifyManager.setScheduler(defaultScheduler);
        unsubscribe();
        serviceGate.resolve();
        await act(async () => {
          await commands.execute("tui:exit", { origin: "slash" });
          await running;
        });
        if (!setup.renderer.isDestroyed) setup.renderer.destroy();
        await fixture.waitForClose();
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    },
  );
}
