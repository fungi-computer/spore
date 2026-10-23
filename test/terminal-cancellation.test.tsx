import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";

import { useTerminalCancellation } from "../src/panes/conversation/terminal-controls.js";

test("Esc stops only the turn; a quick second Esc still stops helpers after the parent becomes idle", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  let setIdle: (() => void) | undefined;
  const calls: string[] = [];
  function Probe() {
    const [idle, changeIdle] = useState(false);
    setIdle = () => {
      changeIdle(true);
    };
    controls = useTerminalCancellation({
      commandId: idle ? undefined : "running",
      status: idle ? "idle" : "thinking",
      dismissInteraction: () => false,
      interaction: null,
      queued: false,
      waitingLabel: undefined,
      cancel: () => {
        calls.push("turn");
        return Promise.resolve();
      },
      stopAll: () => {
        calls.push("tree");
        return Promise.resolve();
      },
      cancelWaiting: () => Promise.resolve(),
      onCancelFailure: (cause) => {
        throw cause;
      },
      exit: undefined,
    });
    return <box />;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    await act(async () => {
      await controls?.keyboard(false);
    });
    expect(calls).toEqual(["turn"]);
    act(() => {
      setIdle?.();
    });
    await act(async () => {
      await controls?.keyboard(false);
    });
    expect(calls).toEqual(["turn", "tree"]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a second Ctrl+C exits even when the first remote cancellation failed", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  let cancels = 0;
  let exits = 0;
  const failures: unknown[] = [];
  const failure = new Error("Command request failed");
  function Probe() {
    controls = useTerminalCancellation({
      commandId: "running-command",
      dismissInteraction: () => false,
      status: "thinking",
      waitingLabel: undefined,
      interaction: null,
      queued: false,
      cancel: () => {
        cancels += 1;
        return Promise.reject(failure);
      },
      cancelWaiting: () => Promise.resolve(),
      onCancelFailure: (cause) => {
        failures.push(cause);
      },
      exit: () => {
        exits += 1;
      },
    });
    return <box />;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    assert.ok(controls);
    await act(async () => {
      await controls?.keyboard(true);
    });
    await act(async () => {
      await controls?.keyboard(true);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(cancels).toBe(1);
    expect(exits).toBe(1);
    expect(failures).toEqual([failure]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a second Ctrl+C exits while the remote cancellation never settles", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  let cancels = 0;
  let exits = 0;
  const failures: unknown[] = [];
  function Probe() {
    controls = useTerminalCancellation({
      commandId: "running-command",
      dismissInteraction: () => false,
      status: "thinking",
      waitingLabel: undefined,
      interaction: null,
      queued: false,
      cancel: () => {
        cancels += 1;
        return new Promise<void>((resolve) => {
          void resolve;
        });
      },
      cancelWaiting: () => Promise.resolve(),
      cancelRequestTimeoutMs: 20,
      onCancelFailure: (cause) => {
        failures.push(cause);
      },
      exit: () => {
        exits += 1;
      },
    });
    return <box />;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    assert.ok(controls);
    await act(async () => {
      await controls?.keyboard(true);
    });
    await act(async () => {
      await controls?.keyboard(true);
    });
    expect(cancels).toBe(1);
    expect(exits).toBe(1);
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
    });
    expect(failures).toEqual([
      expect.objectContaining({
        message: "The local service did not answer the cancellation request",
      }),
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("/cancel reports a bounded failure when the service never replies", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  const failures: unknown[] = [];
  function Probe() {
    controls = useTerminalCancellation({
      commandId: "running-command",
      dismissInteraction: () => false,
      status: "thinking",
      waitingLabel: undefined,
      interaction: null,
      queued: false,
      cancel: () =>
        new Promise<void>((resolve) => {
          void resolve;
        }),
      cancelWaiting: () => Promise.resolve(),
      cancelRequestTimeoutMs: 20,
      onCancelFailure: (cause) => {
        failures.push(cause);
      },
      exit: undefined,
    });
    return <box />;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    assert.ok(controls);
    await act(async () => {
      assert.ok(controls);
      await assert.rejects(controls.cancel(), {
        message: "The local service did not answer the cancellation request",
      });
    });
    expect(failures).toEqual([]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test.each(["retrying", "thinking"] as const)(
  "Esc dispatches cancellation while %s without waiting for remote cleanup",
  async (status) => {
    let controls: ReturnType<typeof useTerminalCancellation> | undefined;
    let cancels = 0;
    let exits = 0;
    const cleanup = Promise.withResolvers<undefined>();
    function Probe() {
      controls = useTerminalCancellation({
        commandId: "running-command",
        dismissInteraction: () => false,
        status,
        waitingLabel: undefined,
        interaction: null,
        queued: false,
        cancel: () => {
          cancels++;
          return cleanup.promise;
        },
        cancelWaiting: () => {
          throw new Error("Active retry is not queued work");
        },
        onCancelFailure: (cause) => {
          throw cause;
        },
        exit: () => {
          exits++;
        },
      });
      return <box />;
    }
    const setup = await testRender(<Probe />, { width: 40, height: 5 });
    try {
      assert.ok(controls);
      // Escape's binding calls keyboard(false); Ctrl+C calls keyboard(true).
      await act(async () => {
        await controls?.keyboard(false);
      });
      expect(cancels).toBe(1);
      expect(exits).toBe(0);
    } finally {
      await act(async () => {
        cleanup.resolve(undefined);
        await cleanup.promise;
      });
      act(() => {
        setup.renderer.destroy();
      });
    }
  },
);

test("Esc shows cancellation immediately and Ctrl+C preserves the next queued prompt", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  let changeStatus: ((status: "thinking" | "queued") => void) | undefined;
  let cancels = 0;
  let queuedCancels = 0;
  let exits = 0;
  const receipt = Promise.withResolvers<undefined>();
  function Probe() {
    const [status, setStatus] = useState<"thinking" | "queued">("thinking");
    changeStatus = setStatus;
    controls = useTerminalCancellation({
      commandId: status === "queued" ? "queued-command" : "running-command",
      dismissInteraction: () => false,
      status,
      waitingLabel: undefined,
      interaction: null,
      queued: status === "queued",
      cancel: () => {
        cancels++;
        return receipt.promise;
      },
      cancelWaiting: () => {
        queuedCancels++;
        return Promise.resolve();
      },
      onCancelFailure: (cause) => {
        throw cause;
      },
      exit: () => {
        exits++;
      },
    });
    return <text>{controls.pending ? "cancelling" : status}</text>;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    assert.ok(controls);
    await act(async () => {
      await controls?.keyboard(false);
    });
    expect(controls.pending).toBe(true);
    await act(async () => {
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("cancelling");
    await act(async () => {
      await controls?.keyboard(false);
    });
    expect(cancels).toBe(1);
    await act(async () => {
      changeStatus?.("queued");
      receipt.resolve(undefined);
      await receipt.promise;
    });
    await act(async () => {
      await setup.renderOnce();
    });
    expect(controls.pending).toBe(false);
    await act(async () => {
      await controls?.keyboard(true);
    });
    // The second Esc had no owner-reported queue; Ctrl+C now preserves it.
    expect(queuedCancels).toBe(0);
    expect(exits).toBe(1);
  } finally {
    receipt.resolve(undefined);
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a new owner command can be cancelled after the previous request was acknowledged", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  let setCommandId: ((commandId: string) => void) | undefined;
  let cancels = 0;
  function Probe() {
    const [commandId, updateCommandId] = useState("first-run");
    setCommandId = updateCommandId;
    controls = useTerminalCancellation({
      commandId,
      dismissInteraction: () => false,
      status: "thinking",
      waitingLabel: undefined,
      interaction: null,
      queued: false,
      cancel: () => {
        cancels++;
        return Promise.resolve();
      },
      cancelWaiting: () => Promise.resolve(),
      onCancelFailure: (cause) => {
        throw cause;
      },
      exit: undefined,
    });
    return <text>{controls.pending ? "cancelling…" : "thinking"}</text>;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    await act(async () => {
      await controls?.keyboard(false);
      await controls?.cancel();
    });
    expect(cancels).toBe(1);
    expect(controls?.pending).toBe(true);
    act(() => {
      setCommandId?.("second-run");
    });
    expect(controls?.pending).toBe(false);
    await act(async () => {
      await controls?.cancel();
    });
    expect(cancels).toBe(2);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("owner-reported cancelling state never repeats an active abort", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  let cancels = 0;
  function Probe() {
    controls = useTerminalCancellation({
      commandId: "running-command",
      dismissInteraction: () => false,
      status: "cancelling",
      waitingLabel: undefined,
      interaction: null,
      queued: false,
      cancel: () => {
        cancels++;
        return Promise.resolve();
      },
      cancelWaiting: () => Promise.resolve(),
      onCancelFailure: (cause) => {
        throw cause;
      },
      exit: undefined,
    });
    return <box />;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    await act(async () => {
      await controls?.keyboard(false);
      await controls?.cancel();
    });
    expect(cancels).toBe(0);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("an acknowledged Esc stays visible and a second Esc cannot cancel the same running turn", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  let cancels = 0;
  function Probe() {
    controls = useTerminalCancellation({
      commandId: "running-command",
      dismissInteraction: () => false,
      status: "thinking",
      waitingLabel: undefined,
      interaction: null,
      queued: false,
      cancel: () => {
        cancels++;
        return Promise.resolve();
      },
      cancelWaiting: () => Promise.resolve(),
      onCancelFailure: (cause) => {
        throw cause;
      },
      exit: undefined,
    });
    return <text>{controls.pending ? "cancelling…" : "thinking"}</text>;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    await act(async () => {
      await controls?.keyboard(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => setup.renderOnce());
    expect(cancels).toBe(1);
    expect(setup.captureCharFrame()).toContain("cancelling…");
    await act(async () => {
      await controls?.keyboard(false);
    });
    expect(cancels).toBe(1);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("Esc leaves waiting work and the composer alone", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  let cancellations = 0;
  function Probe() {
    controls = useTerminalCancellation({
      commandId: "queued-command",
      status: "queued",
      queued: true,
      waitingLabel: undefined,
      interaction: null,
      dismissInteraction: () => false,
      cancel: () => {
        cancellations++;
        return Promise.resolve();
      },
      cancelWaiting: () => {
        cancellations++;
        return Promise.resolve();
      },
      onCancelFailure: (cause) => {
        throw cause;
      },
      exit: () => {
        throw new Error("Esc must not exit");
      },
    });
    return <text>draft stays here</text>;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    await act(async () => {
      await controls?.keyboard(false);
    });
    expect(cancellations).toBe(0);
    expect(setup.captureCharFrame()).toContain("draft stays here");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("each Esc stops the current turn as three queued turns start in order", async () => {
  let controls: ReturnType<typeof useTerminalCancellation> | undefined;
  let advance: (() => void) | undefined;
  const stopped: string[] = [];
  const ids = ["active", "queued-1", "queued-2", "queued-3"];
  function Probe() {
    const [index, setIndex] = useState(0);
    advance = () => {
      setIndex(index + 1);
    };
    const commandId = ids[index];
    controls = useTerminalCancellation({
      commandId,
      status: commandId === undefined ? "idle" : "thinking",
      queued: index < 3,
      waitingLabel: undefined,
      interaction: null,
      dismissInteraction: () => false,
      cancel: () => {
        if (commandId !== undefined) stopped.push(commandId);
        return Promise.resolve();
      },
      cancelWaiting: () => {
        throw new Error("Esc must never withdraw queued work");
      },
      onCancelFailure: (cause) => {
        throw cause;
      },
      exit: () => {
        throw new Error("Esc must not exit");
      },
    });
    return <text>{commandId ?? "idle"}</text>;
  }
  const setup = await testRender(<Probe />, { width: 40, height: 5 });
  try {
    for (let index = 0; index < 4; index++) {
      await act(async () => {
        await controls?.keyboard(false);
      });
      expect(stopped).toEqual(ids.slice(0, index + 1));
      await act(async () => {
        await controls?.keyboard(false);
      });
      expect(stopped).toHaveLength(index + 1);
      // The next owner observation names the next admitted run, without a submit.
      act(() => {
        advance?.();
      });
    }
    await act(async () => {
      await controls?.keyboard(false);
    });
    expect(stopped).toEqual(ids);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const intent of ["Esc", "Ctrl+C", "/cancel"] as const) {
  test(`${intent} requests Session cancellation once when the active run has queued prompts`, async () => {
    let controls: ReturnType<typeof useTerminalCancellation> | undefined;
    let aborts = 0;
    let withdrawals = 0;
    let exits = 0;
    function Probe() {
      controls = useTerminalCancellation({
        commandId: "active-with-queued-prompts",
        status: "thinking",
        queued: true,
        waitingLabel: undefined,
        interaction: null,
        dismissInteraction: () => false,
        cancel: () => {
          aborts++;
          return Promise.resolve();
        },
        cancelWaiting: () => {
          withdrawals++;
          return Promise.resolve();
        },
        onCancelFailure: (cause) => {
          throw cause;
        },
        exit: () => {
          exits++;
        },
      });
      return <box />;
    }
    const setup = await testRender(<Probe />, { width: 40, height: 5 });
    try {
      await act(async () => {
        assert.ok(controls);
        if (intent === "Esc") await controls.keyboard(false);
        else if (intent === "Ctrl+C") await controls.keyboard(true);
        else await controls.cancel();
      });
      expect(aborts).toBe(1);
      expect(withdrawals).toBe(0);
      expect(exits).toBe(0);
      if (intent === "Ctrl+C") {
        await act(async () => {
          assert.ok(controls);
          await controls.keyboard(true);
        });
        expect(aborts).toBe(1);
        expect(exits).toBe(1);
      }
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}
