import { queuedActivity } from "@fungi.computer/parakeet-testing";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { act } from "react";

import { createTuiFixture } from "./fixture.js";
import { sigilGutterText } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import { rendererInteraction } from "../src/renderer-interaction.js";

const idleStatus = `${sigilGutterText("●")}idle`;
const waiting = `${sigilGutterText("●")}queued for host`;

// Native frame waits stop when the renderer is idle; they do not drain Query's
// notification timers. Let awaited React act flush those notifications first.
beforeEach(() => {
  notifyManager.setScheduler(queueMicrotask);
});
afterEach(() => {
  notifyManager.setScheduler(defaultScheduler);
});

async function mount() {
  const fixture = createTuiFixture();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame session={fixture.session} commands={commands} />
    </QueryClientProvider>,
    { width: 100, height: 20, ...rendererInteraction },
  );
  await act(async () => setup.renderOnce());
  await act(async () =>
    setup.waitForFrame((frame) => frame.includes(idleStatus)),
  );
  await setup.waitFor(() =>
    commands.snapshot().slash.some((command) => command.alias === "cancel"),
  );
  const cancel = async () => {
    const command = commands
      .snapshot()
      .slash.find((candidate) => candidate.alias === "cancel");
    if (command === undefined) throw new Error("Missing cancel command");
    await act(async () => {
      await commands.execute(command.commandId, { origin: "slash" });
    });
  };
  const close = async () => {
    await destroyTestRenderer(setup);
    commands.close();
    client.clear();
    await fixture.waitForClose();
  };
  return { fixture, setup, cancel, close };
}

test("shows the owner's waiting state without cancelling queued work", async () => {
  const { fixture, setup, cancel, close } = await mount();
  try {
    await act(async () => {
      await fixture.session.command({
        type: "prompt",
        requestId: "second",
        text: "Second conversation",
        delivery: "followUp",
      });
    });
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes(waiting)),
    );

    await cancel();
    expect(fixture.cancelCalls()).toEqual([]);
    expect(fixture.abortCalls()).toBe(0);
  } finally {
    await close();
  }
});

test("leaves a stale waiting observation alone until the running turn is observed", async () => {
  const { fixture, setup, cancel, close } = await mount();
  try {
    // The observation is stale; the fixture's fresh read has no pending work.
    act(() => {
      fixture.pushFrame({
        kind: "update",
        delivery: "live",
        cursor: null,
        messages: [],
        terminals: [],
        pending: { total: 0, prompts: [], hasMore: false },
        activity: queuedActivity("already-started"),
        extensions: {},
        attention: [],
      });
    });
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes(waiting)),
    );

    await cancel();
    expect(fixture.cancelCalls()).toEqual([]);
    expect(fixture.abortCalls()).toBe(0);
  } finally {
    await close();
  }
});
