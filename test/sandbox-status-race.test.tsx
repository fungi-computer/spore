import { expect, test } from "bun:test";
import { act, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import {
  createSandboxNoticeClaims,
  type TuiSandboxSource,
  type TuiSandboxStatus,
} from "../src/button/local-sandbox.js";
import { TuiFrameContent } from "../src/panes/conversation/frame.js";
import { createTuiFixture } from "./fixture.js";
import { testPaneRender } from "./pane-render.js";

test("late sandbox status from the previous Session cannot replace the current indicator", async () => {
  const fixture = createTuiFixture({ messages: [] });
  const query = createQueryClient();
  const commands = createWhistle();
  const applicationLease = commands.contribute({
    sourceId: "sandbox-status-race",
    namespace: "sandbox-status-race",
    commands: [],
  });
  const claim = createSandboxNoticeClaims();
  const oldReply = Promise.withResolvers<TuiSandboxStatus>();
  const currentReply = Promise.resolve<TuiSandboxStatus>({
    state: "available",
    requireSandbox: false,
  });
  const oldReadStarted = Promise.withResolvers<undefined>();
  const oldSignals: AbortSignal[] = [];
  let oldNoticeClaims = 0;
  const previous: TuiSandboxSource = {
    identity: JSON.stringify(["agent", "previous-session"]),
    read: (signal) => {
      oldSignals.push(signal);
      oldReadStarted.resolve(undefined);
      return oldReply.promise;
    },
    takeUnavailableNotice: () => {
      oldNoticeClaims += 1;
      return claim("agent", "previous-session");
    },
  };
  const current: TuiSandboxSource = {
    identity: JSON.stringify(["agent", "current-session"]),
    read: () => currentReply,
    takeUnavailableNotice: () => claim("agent", "current-session"),
  };
  let selectSource: (source: TuiSandboxSource) => void = () => {
    throw new Error("Sandbox source harness has not mounted");
  };
  function Frame() {
    const [source, setSource] = useState(previous);
    selectSource = setSource;
    return (
      <TuiFrameContent
        session={fixture.session}
        commands={commands}
        applicationCommands={{
          lease: applicationLease,
          exit: () => undefined,
        }}
        initialTheme="mocha"
        sandboxSource={source}
      />
    );
  }
  const setup = await testPaneRender(
    <QueryClientProvider client={query}>
      <Frame />
    </QueryClientProvider>,
    { width: 160, height: 32 },
  );
  try {
    await act(async () => oldReadStarted.promise);
    await act(async () => {
      selectSource(current);
      await currentReply;
    });
    await act(async () =>
      setup.waitForFrame((text) => text.includes("sandbox on")),
    );
    expect(oldSignals.length).toBeGreaterThan(0);
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);

    // A response may already be queued when cancellation reaches its producer.
    await act(async () => {
      oldReply.resolve({
        state: "unavailable",
        requireSandbox: false,
        reason: {
          kind: "missing",
          message: "Previous Session backend missing",
        },
      });
      await oldReply.promise;
    });
    await act(async () => setup.renderOnce());
    const text = setup.captureCharFrame();
    expect(text).toContain("sandbox on");
    expect(text).not.toContain("UNSANDBOXED");
    expect(text).not.toContain("Sandbox unavailable; running unsandboxed.");
    expect(oldNoticeClaims).toBe(0);
    expect(claim("agent", "previous-session")).toBe(true);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    applicationLease.dispose();
    commands.close();
    query.clear();
    await fixture.waitForClose();
  }
});
