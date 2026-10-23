import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { createTestKeymap } from "@opentui/keymap/testing";
import { registerLeader, registerModBindings } from "@opentui/keymap/addons";
import { shellCommands } from "@fungi.computer/nacre/commands";
import {
  createWhistle,
  createWhistleKeymapAdapter,
} from "@fungi.computer/whistle";

test("the shared Open App declaration dispatches with leader then o", async () => {
  const harness = createTestKeymap({ defaultKeys: true });
  const detachMod = registerModBindings(harness.keymap);
  const detachLeader = registerLeader(harness.keymap, { trigger: "ctrl+k" });
  const whistle = createWhistle();
  let opened = 0;
  const lease = whistle.contribute({
    sourceId: "fixture-shell",
    namespace: "shell",
    commands: shellCommands({
      openApp: () => {
        opened += 1;
      },
      showKeys: () => undefined,
      showCommandLine: () => undefined,
      focusStep: () => undefined,
      swapStep: () => undefined,
      toggleZoom: () => undefined,
    }),
  });
  const adapter = createWhistleKeymapAdapter(
    harness.keymap,
    whistle,
    "keyboard",
  );
  try {
    harness.host.focus(harness.root);
    harness.host.press("k", { ctrl: true });
    expect(harness.keymap.hasPendingSequence()).toBe(true);
    harness.host.press("o");
    await setImmediate();
    expect(opened).toBe(1);
    expect(harness.keymap.hasPendingSequence()).toBe(false);
  } finally {
    adapter.cleanup();
    lease.dispose();
    detachLeader();
    detachMod();
    harness.cleanup();
  }
});
