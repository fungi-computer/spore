import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { act, useCallback, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  ParakeetProvider,
  useStatus,
  type ParakeetReconnectOutcome,
  type ParakeetSession,
} from "@fungi.computer/parakeet/headless";
import type {
  SessionFrame,
  SessionSnapshot,
} from "@fungi.computer/shiitake/client";
import { idleActivity } from "@fungi.computer/parakeet-testing";
import { createQueryClient } from "@fungi.computer/agar/query";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ServiceRebind } from "../src/button/index.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { waitForFrame } from "./native-readiness.js";
import {
  ServiceRecoveryOverlay,
  useServiceRecovery,
  type RecoveryClock,
} from "../src/panes/conversation/service-recovery.js";

async function record(name: string, frame: string) {
  const directory = process.env.TUI_RECONNECT_FRAMES;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), frame);
}

function testClock() {
  let now = 0;
  const pending = new Map<() => void, number>();
  const clock: RecoveryClock = {
    now: () => now,
    random: () => 0.5,
    schedule(callback, milliseconds) {
      pending.set(callback, now + milliseconds);
      return () => {
        pending.delete(callback);
      };
    },
  };
  return {
    clock,
    now: () => now,
    async advance(milliseconds: number) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...pending].sort((a, b) => a[1] - b[1])[0];
        if (next === undefined || next[1] > end) break;
        now = next[1];
        pending.delete(next[0]);
        await act(() => {
          next[0]();
          return Promise.resolve();
        });
      }
      now = end;
    },
  };
}

test("reconnect delay jitters and reaches a 30-second ceiling without overlapping attempts", async () => {
  const timer = testClock();
  const attempts: number[] = [];
  const controls: ControlsRef = { current: undefined };
  const setup = await testRender(
    <Harness
      rebind={() => {
        attempts.push(timer.now());
        return Promise.resolve({ kind: "unavailable", alive: true });
      }}
      reconnect={() => Promise.resolve({ kind: "reconnected" })}
      controls={controls}
      clock={{ ...timer.clock, random: () => 0.25 }}
    />,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => {
      controls.current?.setUnavailable(true);
      await setup.renderOnce();
    });
    await timer.advance(120_000);
    const gaps = attempts
      .slice(1)
      .map((at, index) => at - (attempts[index] ?? 0));
    expect(gaps.some((gap) => gap > 20_000)).toBe(true);
    expect(gaps.every((gap) => gap <= 30_000)).toBe(true);
    expect(attempts).toHaveLength(new Set(attempts).size);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

type Controls = {
  setUnavailable: (value: boolean) => void;
};

type ControlsRef = { current: Controls | undefined };

function Harness({
  rebind,
  reconnect,
  controls,
  clock,
}: Readonly<{
  rebind: (signal: AbortSignal) => Promise<ServiceRebind>;
  reconnect: () => Promise<ParakeetReconnectOutcome>;
  controls: ControlsRef;
  clock: RecoveryClock;
}>) {
  const [unavailable, setUnavailable] = useState(false);
  controls.current = { setUnavailable };
  const { colors } = useTerminalTheme("mocha");
  const view = useServiceRecovery({
    observation: unavailable ? "unavailable" : "live",
    reconnect,
    onObservationUnavailable: undefined,
    rebindService: rebind,
    clock,
  });
  return view === undefined ? (
    <text>connected</text>
  ) : (
    <ServiceRecoveryOverlay
      view={view}
      colors={colors}
      onClose={() => undefined}
    />
  );
}

async function mount(
  rebind: (signal: AbortSignal) => Promise<ServiceRebind>,
  reconnect: () => Promise<ParakeetReconnectOutcome>,
) {
  const controls: ControlsRef = { current: undefined };
  const timer = testClock();
  const setup = await testRender(
    <Harness
      rebind={rebind}
      reconnect={reconnect}
      controls={controls}
      clock={timer.clock}
    />,
    { width: 80, height: 24 },
  );
  const settle = async (milliseconds: number) => {
    await timer.advance(milliseconds);
    await act(async () => setup.renderOnce());
  };
  const lose = () =>
    act(async () => {
      controls.current?.setUnavailable(true);
      await setup.renderOnce();
    });
  const heal = () =>
    act(async () => {
      controls.current?.setUnavailable(false);
      await setup.renderOnce();
    });
  return { setup, settle, lose, heal };
}

test("a connection that comes back within the delay shows nothing", async () => {
  const rebound: ServiceRebind = { kind: "rebound" };
  let attempts = 0;
  const { setup, settle, lose, heal } = await mount(
    () => Promise.resolve(rebound),
    () => {
      attempts += 1;
      return Promise.resolve({ kind: "reconnected" });
    },
  );
  try {
    await lose();
    await settle(500);
    expect(setup.captureCharFrame()).not.toContain("Reconnecting");
    // Healed by the first attempt, before the overlay's delay.
    await heal();
    await settle(30_000);
    expect(attempts).toBeGreaterThan(0);
    expect(setup.captureCharFrame()).not.toContain("Reconnecting");
    expect(setup.captureCharFrame()).toContain("connected");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a loss that outlasts the delay shows the overlay, and a successful rebind removes it", async () => {
  let serviceBack = false;
  const { setup, settle, lose, heal } = await mount(
    () =>
      Promise.resolve(
        serviceBack
          ? { kind: "rebound" }
          : { kind: "unavailable", alive: false },
      ),
    () => Promise.resolve({ kind: "reconnected" }),
  );
  try {
    await lose();
    await settle(999);
    expect(setup.captureCharFrame()).not.toContain("Reconnecting");
    await settle(1);
    expect(setup.captureCharFrame()).toContain("Reconnecting to the service");
    expect(setup.captureCharFrame()).toContain(
      "Your conversation will resume.",
    );
    serviceBack = true;
    await settle(200);
    await heal();
    await settle(50);
    expect(setup.captureCharFrame()).not.toContain("Reconnecting");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a service that stays away is named plainly with the command to run", async () => {
  const { setup, settle, lose } = await mount(
    () => Promise.resolve({ kind: "unavailable", alive: false }),
    () => Promise.resolve({ kind: "reconnected" }),
  );
  try {
    await lose();
    await settle(29_999);
    expect(setup.captureCharFrame()).not.toContain("not answering");
    await settle(1);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("The service stopped");
    expect(frame).toContain("fungi resume");
    expect(frame).not.toContain("Reconnecting to the service");
    await record("4-service-down-30s.txt", frame);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a stalled watch with a living service reports busy, not stopped", async () => {
  const { setup, settle, lose } = await mount(
    () => Promise.resolve({ kind: "unavailable", alive: true }),
    () => Promise.resolve({ kind: "reconnected" }),
  );
  try {
    await lose();
    await settle(40_000);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("The service is busy (no reply for 40s)");
    expect(frame).toContain("Your conversation will resume");
    expect(frame).not.toContain("fungi resume");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a rebind that fails says why and keeps retrying", async () => {
  let attempts = 0;
  const { setup, settle, lose } = await mount(
    () => {
      attempts += 1;
      return Promise.reject(new Error("Selection temporarily unavailable"));
    },
    () => Promise.resolve({ kind: "reconnected" }),
  );
  try {
    await lose();
    await settle(30_000);
    expect(setup.captureCharFrame()).toContain(
      "Selection temporarily unavailable",
    );
    expect(attempts).toBeGreaterThan(3);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const name of ["LocalServiceUpdated", "LocalServiceIncompatible"]) {
  test(
    name + " stops retrying and shows only the restart instruction",
    async () => {
      let attempts = 0;
      const message = "The Fungi service was updated. Restart this window.";
      const { setup, settle, lose } = await mount(
        () => {
          attempts += 1;
          const error = new Error(message);
          error.name = name;
          return Promise.reject(error);
        },
        () => Promise.resolve({ kind: "reconnected" }),
      );
      try {
        await lose();
        await settle(250);
        expect(setup.captureCharFrame()).toContain(message);
        await settle(60_000);
        expect(attempts).toBe(1);
        const frame = setup.captureCharFrame();
        expect(frame).toContain(message);
        expect(frame).not.toContain("fungi resume");
        expect(frame).not.toContain("Reconnecting to the service");
        expect(frame).not.toContain("not answering");
        await record(`5-${name}.txt`, frame);
      } finally {
        act(() => {
          setup.renderer.destroy();
        });
      }
    },
  );
}

function ObservedRecovery({
  clock,
  rebind,
  onOutcome,
}: Readonly<{
  clock: RecoveryClock;
  rebind: (signal: AbortSignal) => Promise<ServiceRebind>;
  onOutcome: (outcome: ParakeetReconnectOutcome) => void;
}>) {
  const status = useStatus();
  const reconnect = useCallback(async () => {
    const outcome = await status.reconnect();
    onOutcome(outcome);
    return outcome;
  }, [status.reconnect, onOutcome]);
  const view = useServiceRecovery({
    observation: status.observation.status,
    reconnect,
    onObservationUnavailable: undefined,
    rebindService: rebind,
    clock,
  });
  const { colors } = useTerminalTheme("mocha");
  return (
    <>
      <text>{status.observation.status}</text>
      {view === undefined ? null : (
        <ServiceRecoveryOverlay
          view={view}
          colors={colors}
          onClose={() => undefined}
        />
      )}
    </>
  );
}

test("real controller opening retains outage recovery until a fresh snapshot", async () => {
  type Watch = Awaited<ReturnType<ParakeetSession["watch"]>>;
  const opens: PromiseWithResolvers<Watch>[] = [];
  const snapshot: SessionSnapshot = {
    sessionId: "recovery",
    cursor: null,
    hasMore: false,
    messages: [],
    toolOutput: [],
    progress: null,
    activity: idleActivity,
    terminals: [],
    extensions: {},
    attention: [],
    pending: { total: 0, prompts: [], hasMore: false },
  };
  let closes = 0;
  function watch() {
    const frame = Promise.withResolvers<IteratorResult<SessionFrame>>();
    const value: Watch = {
      snapshot,
      changes: {
        [Symbol.asyncIterator]: () => ({ next: () => frame.promise }),
      },
      close: () => {
        closes += 1;
        frame.resolve({ done: true, value: undefined });
        return Promise.resolve();
      },
    };
    return {
      value,
      lose: () => {
        frame.reject(new Error("Service disconnected"));
      },
    };
  }
  const session: ParakeetSession = {
    address: "fixture://recovery",
    read: () => Promise.resolve(snapshot),
    watch: () => {
      const open = Promise.withResolvers<Watch>();
      opens.push(open);
      return open.promise;
    },
    extension: () => ({
      call: () => Promise.reject(new Error("Unused extension")),
    }),
    command: (): Promise<never> => Promise.reject(new Error("Unused command")),
    withdraw: (): Promise<never> =>
      Promise.reject(new Error("Unused withdrawal")),
    latestPending: (): Promise<never> =>
      Promise.reject(new Error("Unused pending lookup")),
  };
  const timer = testClock();
  const queryClient = createQueryClient();
  const failed = Promise.withResolvers<undefined>();
  const outcomes: ParakeetReconnectOutcome[] = [];
  const onOutcome = (outcome: ParakeetReconnectOutcome) => {
    outcomes.push(outcome);
    if (outcome.kind === "failed") failed.resolve(undefined);
  };
  const signals: AbortSignal[] = [];
  const rebind = (signal: AbortSignal): Promise<ServiceRebind> => {
    signals.push(signal);
    return Promise.resolve({ kind: "rebound" });
  };
  const setup = await testRender(
    <QueryClientProvider client={queryClient}>
      <ParakeetProvider session={session}>
        <ObservedRecovery
          clock={timer.clock}
          rebind={rebind}
          onOutcome={onOutcome}
        />
      </ParakeetProvider>
    </QueryClientProvider>,
    { width: 80, height: 24 },
  );
  const flush = () =>
    act(async () => {
      // Flush the maintained query observer's scheduled notifications.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
    });
  const observe = async (status: "live" | "connecting" | "unavailable") => {
    // Query notifications and React's subscription update occupy separate
    // turns. Await the actual controller state, not one assumed flush turn.
    for (let turn = 0; turn < 100; turn += 1) {
      await flush();
      if (setup.captureCharFrame().startsWith(status)) return;
    }
    expect(setup.captureCharFrame().startsWith(status)).toBe(true);
  };
  try {
    await flush();
    expect(opens).toHaveLength(1);
    await timer.advance(30_000);
    await flush();
    expect(signals).toHaveLength(0);
    expect(setup.captureCharFrame()).not.toContain("fungi resume");
    const first = watch();
    opens[0]?.resolve(first.value);
    await observe("live");
    expect(setup.captureCharFrame()).toContain("live");
    first.lose();
    await observe("unavailable");
    expect(setup.captureCharFrame()).toContain("unavailable");
    await timer.advance(250);
    await observe("connecting");
    expect(opens).toHaveLength(2);
    expect(setup.captureCharFrame()).toContain("connecting");
    await timer.advance(750);
    await flush();
    expect(setup.captureCharFrame()).toContain("Reconnecting to the service");
    expect(signals[0]?.aborted).toBe(false);
    await timer.advance(29_000);
    await flush();
    expect(setup.captureCharFrame()).toContain("The service is busy");
    // The real controller deadline must return to unavailable, allowing retry.
    await failed.promise;
    await observe("unavailable");
    expect(outcomes).toContainEqual({
      kind: "failed",
      cause: "Session history did not reopen within 10 seconds",
    });
    expect(setup.captureCharFrame()).toContain("unavailable");
    await timer.advance(500);
    await observe("connecting");
    expect(opens).toHaveLength(3);
    expect(setup.captureCharFrame()).toContain("The service is busy");
    // A late snapshot from the cancelled watch must not heal this outage.
    opens[1]?.resolve(watch().value);
    await flush();
    expect(setup.captureCharFrame()).toContain("The service is busy");
    opens[2]?.resolve(watch().value);
    await waitForFrame(
      setup,
      (frame) => frame.startsWith("live") && !frame.includes("fungi resume"),
    );
    expect(setup.captureCharFrame()).toContain("live");
    expect(setup.captureCharFrame()).not.toContain("fungi resume");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const attempts = signals.length;
    await timer.advance(60_000);
    await flush();
    expect(signals).toHaveLength(attempts);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    queryClient.clear();
  }
  expect(closes).toBe(3);
}, 20_000);
