import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
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
import { waitForFrame } from "./native-readiness.js";

/** The host's collapsed footer slot: one child the service says is working. */
const workingSlot = (): SessionExtensionSlots => ({
  [subagentsContract.id]: {
    status: "running",
    revision: "sha256:service-loss-fixture",
    // The host advertises `/agents`, which the summary row's action runs.
    catalog: {
      protocol: "whistle.catalog/v1",
      commands: [
        {
          id: "agents",
          title: "Agents",
          category: "Conversation",
          projections: { slash: { aliases: ["agents"] } },
        },
      ],
    },
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
      uncounted: 0,
      counts: {
        working: 1,
        waiting_on_agent: 0,
        needs_you: 0,
        idle: 0,
        failed: 0,
        unavailable: 0,
      },
      escalated: 0,
      waitingOn: [],
      escalatedBy: [],
      expanded: false,
    }),
  },
});

test("the footer stops saying a child is working once the service is lost, and says it again only from a fresh snapshot", async () => {
  notifyManager.setScheduler(queueMicrotask);
  const fixture = createTuiFixture();
  const lost = Promise.withResolvers<never>();
  let watches = 0;
  let serviceBack = false;
  const session: ParakeetSession = {
    ...fixture.session,
    read: async (input) => ({
      ...(await fixture.session.read(input)),
      extensions: workingSlot(),
    }),
    watch: async (input) => {
      watches += 1;
      if (watches > 1 && !serviceBack)
        throw new Error("connect ECONNREFUSED 127.0.0.1");
      const watch = await fixture.session.watch(input);
      return {
        ...watch,
        snapshot: { ...watch.snapshot, extensions: workingSlot() },
        // The first observation ends the way a killed service ends it.
        changes:
          watches > 1
            ? watch.changes
            : {
                [Symbol.asyncIterator]: () => {
                  const inner = watch.changes[Symbol.asyncIterator]();
                  return {
                    next: () => Promise.race([inner.next(), lost.promise]),
                    return: () =>
                      inner.return?.() ??
                      Promise.resolve({ done: true, value: undefined }),
                  };
                },
              },
      };
    },
  };
  const commands = createWhistle();
  const query = createQueryClient();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        initialTheme="mocha"
        session={session}
        clients={[subagentsClient]}
        commands={commands}
      />
    </QueryClientProvider>,
    { width: 120, height: 40 },
  );
  try {
    await waitForFrame(setup, (frame) => frame.includes("1 sub-agent"));
    expect(setup.captureCharFrame()).toContain("1 working");

    // The service dies: its observation fails and no reconnect succeeds.
    lost.reject(new Error("Service disconnected"));
    await waitForFrame(setup, (frame) => frame.includes("Reconnecting"));
    const lostFrame = setup.captureCharFrame();
    expect(lostFrame).not.toContain("working");
    expect(lostFrame).not.toContain("sub-agent");

    // A restarted service answers; the fresh snapshot restores the row.
    serviceBack = true;
    await waitForFrame(setup, (frame) => frame.includes("1 working"));
    expect(setup.captureCharFrame()).not.toContain("Reconnecting");
  } finally {
    await destroyTestRenderer(setup);
    commands.close();
    query.clear();
    notifyManager.setScheduler(defaultScheduler);
  }
}, 20_000);
