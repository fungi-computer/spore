import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import type { ParakeetSession } from "@fungi.computer/parakeet/headless";
import type { SessionExtensionSlots } from "@fungi.computer/shiitake/client";
import * as Schema from "effect/Schema";
import subagentsClient from "@fungi.computer/shiitake-extensions/subagents/client";
import {
  subagentsContract,
  SubagentsProjection,
} from "@fungi.computer/shiitake-extensions/subagents";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";

const slots: SessionExtensionSlots = {
  [subagentsContract.id]: {
    status: "running",
    revision: "sha256:subagents-fixture",
    value: Schema.encodeSync(SubagentsProjection)({
      agents: [
        {
          agentId: "agent-scout",
          name: "Scout",
          sessionId: "scout-main",
          state: "working",
        },
        {
          agentId: "agent-critic",
          name: "Critic",
          sessionId: "critic-main",
          state: "waiting",
          attention: "Approve files.write",
        },
        {
          agentId: "agent-scribe",
          name: "Scribe",
          sessionId: "scribe-main",
          state: "idle",
        },
        {
          agentId: "agent-fresh",
          name: "Fresh",
          sessionId: null,
          state: "idle",
        },
      ],
      more: 0,
    }),
  },
};

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  test(`sub-agent rows show live status and a click opens one beside the parent (${String(width)}×${String(height)})`, async () => {
    notifyManager.setScheduler(queueMicrotask);
    const fixture = createTuiFixture();
    const session: ParakeetSession = {
      ...fixture.session,
      read: async (input) => ({
        ...(await fixture.session.read(input)),
        extensions: slots,
      }),
      watch: async (input) => {
        const watch = await fixture.session.watch(input);
        return {
          ...watch,
          snapshot: { ...watch.snapshot, extensions: slots },
        };
      },
    };
    const opened: unknown[] = [];
    const peer = createTuiFixture();
    const commands = createWhistle();
    const query = createQueryClient();
    const setup = await testRender(
      <QueryClientProvider client={query}>
        <TuiFrame
          initialTheme="mocha"
          session={session}
          clients={[subagentsClient]}
          commands={commands}
          acquireSession={(target) => {
            opened.push(target);
            return Promise.resolve({
              session: {
                ...peer.session,
                address: "fixture://agent-critic/critic-main",
              },
              context: { agentName: "Critic" },
              close: () => Promise.resolve(),
            });
          }}
        />
      </QueryClientProvider>,
      { width, height },
    );
    const frame = async (text: string) => {
      try {
        await act(async () =>
          setup.waitForFrame((value) => value.includes(text)),
        );
      } catch (cause) {
        throw new Error(`Expected native frame: ${text}`, { cause });
      }
    };
    const output = process.env.TUI_SUBAGENTS_CAPTURE_DIR;
    try {
      await frame("Scout · working");
      const before = setup.captureCharFrame();
      expect(before).toContain("Critic · waiting on you · Approve files.write");
      expect(before).toContain("Scribe · idle");
      expect(before).toContain("Fresh · idle · not messaged yet");
      await captureFrame(setup, output, `subagents-footer-${String(width)}`);
      // A created, never-messaged Agent has no conversation to open.
      const fresh = before
        .split("\n")
        .findIndex((line) => line.includes("Fresh · idle"));
      await act(async () => {
        await setup.mockMouse.click(10, fresh);
      });
      await act(async () => setup.renderOnce());
      expect(opened).toEqual([]);
      const critic = before
        .split("\n")
        .findIndex((line) => line.includes("Critic · waiting on you"));
      await act(async () => {
        await setup.mockMouse.click(10, critic);
      });
      await act(async () => setup.waitForFrame(() => peer.watchCalls() === 1));
      expect(opened).toEqual([
        { agentId: "agent-critic", sessionId: "critic-main" },
      ]);
      await act(async () => setup.renderOnce());
      // The parent stays open in its own pane beside the child.
      expect(fixture.closeCalls()).toBe(0);
      expect(setup.captureCharFrame()).toContain("Scout · working");
      await captureFrame(setup, output, `subagents-beside-${String(width)}`);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      commands.close();
      query.clear();
      await fixture.waitForClose();
      if (peer.watchCalls() > 0) await peer.waitForClose();
      notifyManager.setScheduler(defaultScheduler);
    }
  });
}
