import { expect, test } from "bun:test";
import { KeyEvent, RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { WhistleCommand } from "@fungi.computer/whistle";
import { act } from "react";

import type {
  PaneKit,
  PaneStatusItem,
  PaneTarget,
  PaneValue,
} from "../src/button/index.js";
import { createPresentation } from "../src/button/presentation.js";
import { probePane } from "./fixtures/probe-pane/probe-pane.js";

function value<Value>(initial: Value) {
  let current = initial;
  const listeners = new Set<() => void>();
  const store: PaneValue<Value> = {
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    store,
    set: (next: Value) => {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

function key(name: string) {
  return new KeyEvent({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: name,
    number: false,
    raw: name,
    eventType: "press",
    source: "raw",
  });
}

/** A test double of the shell: records what the pane asks of the kit. */
function fakeKit() {
  const viewport = value({ width: 40, height: 10 });
  const focused = value(false);
  const commands = new Map<string, WhistleCommand<never>>();
  const status = new Map<number, PaneStatusItem>();
  const keyHandlers = new Set<(event: KeyEvent) => boolean>();
  const replaced: PaneTarget[] = [];
  const colors = RGBA.fromHex("#808080");
  const abort = new AbortController();
  let statusId = 0;
  const kit: PaneKit = {
    paneId: "probe-1",
    setTitle: () => undefined,
    presentTheme: () => ({ update: () => undefined, dispose: () => undefined }),
    exit: () => undefined,
    rendering: {
      afterFrame: () => () => undefined,
      requestFrame: () => undefined,
      isFocused: () => false,
    },
    viewport: viewport.store,
    input: {
      focused: focused.store,
      onKey: (handler) => {
        keyHandlers.add(handler);
        return () => {
          keyHandlers.delete(handler);
        };
      },
      onPaste: () => () => undefined,
      requestFocus: () => {
        focused.set(true);
      },
    },
    commands: {
      commandId: (id) => `probe:${id}`,
      contribute: (contributed) => {
        for (const command of contributed) commands.set(command.id, command);
        return {
          update: () => undefined,
          dispose: () => {
            for (const command of contributed) commands.delete(command.id);
          },
        };
      },
      execute: () => Promise.reject(new Error("not used by the probe")),
      snapshot: () => ({
        bindings: [],
        palette: [],
        slash: [],
        help: [],
        menu: [],
        agent: [],
      }),
      subscribe: () => () => undefined,
      present: () => () => undefined,
    },
    dialogs: {
      dismiss: () => false,
      show: () => ({ dismiss: () => undefined, isCurrent: () => false }),
      open: value(false).store,
    },
    status: {
      items: {
        read: () => [...status.values()],
        subscribe: () => () => undefined,
      },
      contribute: (item) => {
        const id = (statusId += 1);
        status.set(id, item);
        return {
          update: (next) => status.set(id, next),
          dispose: () => status.delete(id),
        };
      },
    },
    replace: (target) => {
      replaced.push(target);
      return Promise.resolve({ kind: "opened", paneId: "probe-1" });
    },
    notify: () => undefined,
    sessions: {
      acquire: () => Promise.reject(new Error("not used by the probe")),
    },
    theme: value(
      createPresentation(
        {
          background: colors,
          surface: colors,
          selection: colors,
          selectionForeground: colors,
          foreground: colors,
          primary: colors,
          accent: colors,
          success: colors,
          info: colors,
          warning: colors,
          error: colors,
        },
        true,
      ),
    ).store,
    signal: abort.signal,
    onDispose: () => undefined,
    guardClose: () => () => undefined,
    guardQuit: () => () => undefined,
  };
  // The shell delivers keys only to the focused pane.
  const press = (name: string) => {
    if (!focused.store.read()) return false;
    for (const handler of keyHandlers) if (handler(key(name))) return true;
    return false;
  };
  return { kit, viewport, focused, commands, status, replaced, press };
}

test("a probe pane does what the conversation needs using only the Button", async () => {
  expect(probePane.instantiate({ kind: "conversation" })).toBeUndefined();
  const instance = probePane.instantiate({ kind: "probe", label: "alpha" });
  if (instance === undefined) throw new Error("probe target did not parse");
  expect(instance.key).toBe("probe:alpha");
  const shell = fakeKit();
  const setup = await testRender(<>{instance.render(shell.kit)}</>, {
    width: 60,
    height: 4,
  });
  try {
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("alpha 40x10 keys:");

    expect([...shell.status.values()]).toEqual([
      {
        slot: "chips",
        order: 1,
        text: "Probe alpha",
        compact: "Probe",
        tone: "info",
      },
    ]);
    const open = shell.commands.get("switch-conversation");
    expect(open?.projections?.bindings?.values).toEqual(["o"]);

    expect(shell.press("x")).toBe(false);
    act(() => {
      shell.kit.input.requestFocus();
      shell.viewport.set({ width: 30, height: 6 });
    });
    act(() => {
      expect(shell.press("x")).toBe(true);
    });
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("alpha 30x6 focused keys:x");

    await open?.handler({ origin: "keyboard" });
    expect(shell.replaced).toEqual([
      {
        kind: "conversation",
        agentId: "local",
        sessionId: null,
        createRequestId: "probe-new-conversation",
      },
    ]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
  expect(shell.commands.size).toBe(0);
  expect(shell.status.size).toBe(0);
});
