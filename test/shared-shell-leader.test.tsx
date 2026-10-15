import { expect, test } from "bun:test";
import { createAppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import { shellCommands } from "@fungi.computer/oyster/shell/commands";
import {
  leaderKeys,
  leaderKeyMatches,
  parseChord,
} from "@fungi.computer/oyster/shell/keys";
import {
  createParakeetInteractions,
  parakeetBuiltinCommands,
  runSlashDraft,
} from "@fungi.computer/parakeet/headless";
import { createWhistle } from "@fungi.computer/whistle";
import { createQueryClient } from "@fungi.computer/agar/query";
import { openTerminalApplication } from "../src/terminal-application.js";
import { createRoot } from "@opentui/react";
import type { PaneCommands } from "../src/button/index.js";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

test("two Parakeet contributions coexist in one Whistle with focused presenters", async () => {
  const host = createAppSurfaceCommandHost();
  const first = host.mountPane("first");
  const second = host.mountPane("second");
  const firstCommands: PaneCommands = first;
  const secondCommands: PaneCommands = second;
  let clearedFirst = 0;
  let clearedSecond = 0;
  firstCommands.contribute(
    parakeetBuiltinCommands(firstCommands, {
      clear: () => {
        clearedFirst += 1;
      },
    }),
  );
  secondCommands.contribute(
    parakeetBuiltinCommands(secondCommands, {
      clear: () => {
        clearedSecond += 1;
      },
    }),
  );
  const firstStore = createParakeetInteractions();
  const secondStore = createParakeetInteractions();
  const detachFirst = firstStore.attach(firstCommands.present);
  const detachSecond = secondStore.attach(secondCommands.present);
  const send = () => {
    throw new Error("a command must not send a prompt");
  };
  try {
    expect(host.snapshot().slash).toHaveLength(6);
    expect(first.snapshot().slash.map((row) => row.alias)).toEqual([
      "help",
      "keys",
      "clear",
    ]);
    expect(second.snapshot().slash.map((row) => row.alias)).toEqual([
      "help",
      "keys",
      "clear",
    ]);
    host.focus("first");
    await runSlashDraft("/clear", firstCommands, send, "slash");
    expect(clearedFirst).toBe(1);
    expect(clearedSecond).toBe(0);
    expect(
      await runSlashDraft("/clear", secondCommands, send, "slash"),
    ).toEqual({ status: "missing" });

    const running = runSlashDraft("/help", firstCommands, send, "slash");
    const prompt = firstStore.snapshot().open?.host.snapshot().prompt;
    expect(prompt?.request.type).toBe("choice");
    expect(secondStore.snapshot().open).toBeUndefined();
    if (prompt?.request.type !== "choice")
      throw new Error("help prompt absent");
    expect(prompt.request.options.map((row) => row.label)).toEqual([
      "/keys",
      "/clear",
    ]);
    firstStore.close();
    await running;

    host.focus("second");
    await runSlashDraft("/clear", secondCommands, send, "slash");
    expect(clearedSecond).toBe(1);
    const secondRunning = runSlashDraft("/help", secondCommands, send, "slash");
    expect(secondStore.snapshot().open).toBeDefined();
    secondStore.close();
    await secondRunning;
    first.dispose();
    expect(second.snapshot().slash).toHaveLength(3);
    second.dispose();
    expect(host.snapshot().slash).toEqual([]);
  } finally {
    detachFirst();
    detachSecond();
    firstStore.close();
    secondStore.close();
    host.dispose();
  }
});

test("shared-shell-leader uses the same declarations and focused rows on both hosts", async () => {
  const host = createAppSurfaceCommandHost();
  let keys = 0;
  let zoom = 0;
  let back = 0;
  host.registerShellCommands(
    shellCommands({
      openApp: () => undefined,
      showKeys: () => {
        keys += 1;
      },
      showCommandLine: () => undefined,
      focusStep: () => undefined,
      swapStep: () => undefined,
      back: () => {
        back += 1;
      },
      toggleZoom: () => {
        zoom += 1;
      },
    }),
  );
  const first = host.mountPane("first");
  const second = host.mountPane("second");
  let firstKey = 0;
  let secondKey = 0;
  const contribution = (run: () => void) => [
    {
      id: "zoom",
      title: "Pane zoom",
      category: "Pane",
      projections: { bindings: { values: ["<leader> z"] } },
      handler: run,
    },
  ];
  first.contribute(
    contribution(() => {
      firstKey += 1;
    }),
  );
  second.contribute(
    contribution(() => {
      secondKey += 1;
    }),
  );
  try {
    // Browser Mod-K and terminal Ctrl-K select the same shell command.
    expect(parseChord("mod+k", true)?.meta).toBe(true);
    expect(parseChord("mod+k", false)?.ctrl).toBe(true);
    await host.execute("shell:show-command-palette", { origin: "keyboard" });
    expect(keys).toBe(1);
    const backRow = leaderKeys(host.active()).find((row) => row.key === "[");
    if (backRow === undefined) throw new Error("Back leader key absent");
    await host.execute(backRow.commandId, { origin: "keyboard" });
    expect(back).toBe(1);
    expect(
      host
        .active()
        .bindings.some(
          (row) =>
            row.commandId === backRow.commandId && row.binding === "cmd+[",
        ),
    ).toBe(true);
    host.focus("first");
    const chosen = leaderKeys(host.active()).find((row) =>
      leaderKeyMatches(
        { key: "z", ctrlKey: false, metaKey: false, altKey: false },
        row.key,
      ),
    );
    if (chosen === undefined) throw new Error("leader key absent");
    await host.execute(chosen.commandId, { origin: "keyboard" });
    expect(firstKey).toBe(1);
    expect(secondKey).toBe(0);
    expect(zoom).toBe(0);
    host.focus("second");
    expect(
      await host.execute(chosen.commandId, { origin: "keyboard" }),
    ).toEqual({ status: "missing" });
    second.dispose();
    const global = leaderKeys(host.active()).find((row) => row.key === "z");
    if (global === undefined) throw new Error("shell leader key absent");
    await host.execute(global.commandId, { origin: "keyboard" });
    expect(zoom).toBe(1);
  } finally {
    host.dispose();
  }
});

test("the native TUI keymap projects only globals and the focused pane", async () => {
  const setup = await testRender(<box />, { width: 20, height: 4 });
  const application = await openTerminalApplication({
    signals: { on: () => undefined, off: () => undefined },
    createQueryClient,
    createRenderer: () => Promise.resolve(setup.renderer),
    createRoot,
    createWhistle,
    enableKeymap: true,
  });
  if (application === undefined)
    throw new Error("Terminal fixture did not open");
  const host = application.commandHost;
  const first = host.mountPane("first");
  const second = host.mountPane("second");
  let firstKeys = 0;
  let secondKeys = 0;
  let globalKeys = 0;
  let paletteKeys = 0;
  const row = (run: () => void) => [
    {
      id: "key",
      title: "Key",
      category: "Pane",
      projections: { bindings: { values: ["ctrl+x"] } },
      handler: run,
    },
  ];
  host.registerShellCommands([
    ...shellCommands({
      openApp: () => undefined,
      showKeys: () => {
        paletteKeys += 1;
      },
      showCommandLine: () => undefined,
      focusStep: () => undefined,
      swapStep: () => undefined,
      toggleZoom: () => undefined,
      back: () => undefined,
    }).filter((command) => command.id === "show-command-palette"),
    ...row(() => {
      globalKeys += 1;
    }),
  ]);
  first.contribute(
    row(() => {
      firstKeys += 1;
    }),
  );
  second.contribute(
    row(() => {
      secondKeys += 1;
    }),
  );
  try {
    await act(async () => {
      await setup.renderOnce();
      setup.mockInput.pressKey("x", { ctrl: true });
    });
    await act(async () => {
      setup.mockInput.pressKey("k", { ctrl: true });
      await setup.renderOnce();
    });
    expect(paletteKeys).toBe(1);
    expect(globalKeys).toBe(1);
    expect(firstKeys).toBe(0);
    expect(secondKeys).toBe(0);
    host.focus("first");
    await act(async () => {
      setup.mockInput.pressKey("x", { ctrl: true });
      await setup.renderOnce();
    });
    expect(firstKeys).toBe(1);
    expect(secondKeys).toBe(0);
    host.focus("second");
    await act(async () => {
      setup.mockInput.pressKey("x", { ctrl: true });
      await setup.renderOnce();
    });
    expect(secondKeys).toBe(1);
    first.dispose();
    await act(async () => {
      setup.mockInput.pressKey("x", { ctrl: true });
      await setup.renderOnce();
    });
    expect(secondKeys).toBe(2);
    second.dispose();
    await act(async () => {
      setup.mockInput.pressKey("x", { ctrl: true });
      await setup.renderOnce();
    });
    expect(globalKeys).toBe(2);
  } finally {
    await act(async () => {
      await application.close();
    });
  }
});
