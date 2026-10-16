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

const slots: SessionExtensionSlots = {
  [subagentsContract.id]: {
    status: "running",
    revision: "sha256:beside-theme-fixture",
    value: Schema.encodeSync(SubagentsProjection)({
      agents: [
        {
          agentId: "agent-scout",
          name: "Scout",
          sessionId: "scout-main",
          state: "working",
        },
      ],
      more: 0,
    }),
  },
};

test("a pane opened beside carries the shell theme, not the launch theme", async () => {
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
      return { ...watch, snapshot: { ...watch.snapshot, extensions: slots } };
    },
  };
  const peer = createTuiFixture();
  const commands = createWhistle();
  const query = createQueryClient();
  const width = 160;
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        initialTheme="latte"
        session={session}
        clients={[subagentsClient]}
        commands={commands}
        // The Session was acquired while the shell still held its launch theme.
        acquireSession={() =>
          Promise.resolve({
            session: {
              ...peer.session,
              address: "fixture://agent-scout/scout-main",
            },
            context: { agentName: "Scout", themeName: "terminal" },
            close: () => Promise.resolve(),
          })
        }
      />
    </QueryClientProvider>,
    { width, height: 48 },
  );
  const background = (x: number, y: number) => {
    let column = 0;
    for (const span of setup.captureSpans().lines[y]?.spans ?? []) {
      if (x < column + span.width) return span.bg.toInts().join(",");
      column += span.width;
    }
    return undefined;
  };
  try {
    await act(async () =>
      setup.waitForFrame((value) => value.includes("Scout · working")),
    );
    const rows = setup.captureCharFrame().split("\n");
    const scout = rows.findIndex((line) => line.includes("Scout · working"));
    await act(async () => {
      await setup.mockMouse.click(10, scout);
    });
    await act(async () => setup.waitForFrame(() => peer.watchCalls() === 1));
    await act(async () => setup.renderOnce());
    const left = background(10, 1);
    const right = background(width - 10, 1);
    expect(left).toBeDefined();
    expect(right).toBe(left);
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
