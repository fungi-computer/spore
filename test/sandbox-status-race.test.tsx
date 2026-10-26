import { expect, test } from "bun:test";
import { act, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import type {
  TuiSandboxSource,
  TuiSandboxStatus,
} from "../src/button/local-sandbox.js";
import { TuiFrameContent } from "../src/panes/conversation/frame.js";
import { createTuiFixture } from "./fixture.js";
import { testPaneRender } from "./pane-render.js";

test("late status from a previous Session cannot replace the current mode", async () => {
  const fixture = createTuiFixture({ messages: [] });
  const query = createQueryClient();
  const commands = createWhistle();
  const applicationLease = commands.contribute({
    sourceId: "sandbox-status-race",
    namespace: "sandbox-status-race",
    commands: [],
  });
  const oldReply = Promise.withResolvers<TuiSandboxStatus>();
  const currentReply = Promise.resolve<TuiSandboxStatus>({
    mode: "workspace",
    available: true,
  });
  const oldReadStarted = Promise.withResolvers<undefined>();
  const oldSignals: AbortSignal[] = [];
  const previous: TuiSandboxSource = {
    identity: "agent/previous-session",
    read: (signal) => {
      oldSignals.push(signal);
      oldReadStarted.resolve(undefined);
      return oldReply.promise;
    },
  };
  const current: TuiSandboxSource = {
    identity: "agent/current-session",
    read: () => currentReply,
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
      setup.waitForFrame((text) => text.includes("workspace · sandboxed")),
    );
    expect(oldSignals.length).toBeGreaterThan(0);
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => {
      oldReply.resolve({
        mode: "full-access",
        available: false,
        reason: { kind: "install", message: "Previous backend missing" },
      });
      await oldReply.promise;
    });
    await act(async () => setup.renderOnce());
    const text = setup.captureCharFrame();
    expect(text).toContain("workspace · sandboxed");
    expect(text).not.toContain("full access");
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
