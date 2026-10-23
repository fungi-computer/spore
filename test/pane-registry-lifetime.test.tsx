import { z } from "zod";
import { expect, test } from "bun:test";
import { KeyEvent, PasteEvent, RGBA } from "@opentui/core";
import { createWhistle } from "@fungi.computer/whistle";
import { createAppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import {
  definePaneKind,
  type PaneKit,
  type PaneKindEntry,
} from "../src/button/index.js";
import { createPaneRegistry } from "../src/shell/registry.js";
import { paneValue } from "../src/shell/value.js";
import { probePane } from "./fixtures/probe-pane/probe-pane.js";
import { createPresentation } from "../src/button/presentation.js";
import { createToastStore } from "../src/button/toast-store.js";

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

function workspace(
  prepare?: (name: string, kit: PaneKit) => void | Promise<void>,
  additionalKinds: readonly PaneKindEntry[] = [],
) {
  const whistle = createWhistle();
  const commands = createAppSurfaceCommandHost(whistle);
  const color = RGBA.fromHex("#808080");
  const presentation = createPresentation(
    {
      background: color,
      foreground: color,
      surface: color,
      selection: color,
      selectionForeground: color,
      primary: color,
      accent: color,
      success: color,
      info: color,
      warning: color,
      error: color,
    },
    true,
    { foreground: color, background: color },
  );
  const kits = new Map<string, PaneKit>();
  const received: string[] = [];
  const cleaned: string[] = [];
  const overlay = paneValue(false);
  const toasts = createToastStore();
  // This host fixture has no builtin kind, renderer or Session-specific path.
  const targetSchema = z.object({
    kind: z.literal("fixture"),
    name: z.string(),
  });
  const kind = definePaneKind<Readonly<{ kind: "fixture"; name: string }>>({
    kind: "fixture",
    parse: (target) => {
      const parsed = targetSchema.safeParse(target);
      return parsed.success ? parsed.data : undefined;
    },
    key: (target) => target.name,
    title: (target) => target.name,
    View: () => null,
  });
  const entry = {
    ...kind,
    instantiate: (target: Parameters<typeof kind.instantiate>[0]) => {
      const instance = kind.instantiate(target);
      if (instance === undefined) return undefined;
      return {
        ...instance,
        render: async (kit: PaneKit) => {
          kits.set(instance.key, kit);
          kit.input.onKey((event) => {
            received.push(instance.key + ":" + event.name);
            return true;
          });
          kit.input.onPaste((event) => {
            received.push(
              instance.key + ":paste:" + new TextDecoder().decode(event.bytes),
            );
          });
          kit.commands.contribute([
            {
              id: "same",
              title: "Same command",
              category: "Fixture",
              projections: { palette: { order: 1 } },
              handler: () => undefined,
            },
          ]);
          kit.status.contribute({
            slot: "chips",
            order: 1,
            text: instance.title,
            tone: "info",
          });
          kit.onDispose(() => {
            cleaned.push(instance.key);
          });
          await prepare?.(instance.key, kit);
          return instance.render(kit);
        },
      };
    },
  };
  const registry = createPaneRegistry({
    kinds: [entry, ...additionalKinds],
    exit: () => undefined,
    rendering: {
      afterFrame: () => () => undefined,
      requestFrame: () => undefined,
      isFocused: () => false,
    },
    commands,
    viewport: { width: 160, height: 48 },
    minima: { width: 32, height: 8 },
    theme: paneValue(presentation).value,
    dialogs: {
      dismiss: () => false,
      open: overlay.value,
      show: () => ({ dismiss: () => undefined, isCurrent: () => false }),
    },
    sessions: {
      acquire: () => Promise.reject(new Error("Fixture has no Session")),
    },
    toast: toasts.show,
  });
  return {
    registry,
    whistle,
    commands,
    kits,
    received,
    cleaned,
    overlay,
    toasts,
    dispose: async () => {
      await registry.dispose();
      toasts.dispose();
      commands.dispose();
      whistle.close();
      presentation.syntax.destroy();
    },
  };
}

test("pane viewports use every row and reserve only a visible divider column", async () => {
  const host = workspace();
  try {
    await host.registry.open({ kind: "fixture", name: "alpha" });
    expect(host.kits.get("alpha")?.viewport.read()).toEqual({
      width: 160,
      height: 48,
    });
    const beta = await host.registry.open({ kind: "fixture", name: "beta" });
    if (beta.kind === "refused") throw new Error(beta.reason);
    const checkTiled = () => {
      for (const pane of host.registry.read()) {
        expect(host.kits.get(pane.title)?.viewport.read()).toEqual({
          width:
            pane.frame.width - (pane.frame.x + pane.frame.width < 160 ? 1 : 0),
          height: pane.frame.height,
        });
      }
    };
    checkTiled();
    host.registry.toggleZoom(beta.paneId);
    expect(host.kits.get("beta")?.viewport.read()).toEqual({
      width: 160,
      height: 48,
    });
    host.registry.toggleZoom(beta.paneId);
    host.registry.setLayout("main-top");
    checkTiled();
    await host.registry.close(beta.paneId);
    expect(host.kits.get("alpha")?.viewport.read()).toEqual({
      width: 160,
      height: 48,
    });
  } finally {
    await host.dispose();
  }
});

test("named layouts reach live pane viewports without recreating pane kits", async () => {
  const host = workspace();
  try {
    for (const name of ["alpha", "beta", "gamma", "delta"])
      await host.registry.open({ kind: "fixture", name });
    const original = new Map(host.kits);
    host.registry.setLayout("grid");
    expect(host.registry.read().map((pane) => pane.frame)).toEqual([
      { x: 0, y: 0, width: 80, height: 24 },
      { x: 80, y: 0, width: 80, height: 24 },
      { x: 0, y: 24, width: 80, height: 24 },
      { x: 80, y: 24, width: 80, height: 24 },
    ]);
    expect(host.kits.get("alpha")?.viewport.read()).toEqual({
      width: 79,
      height: 24,
    });
    expect(host.kits.get("delta")?.viewport.read()).toEqual({
      width: 80,
      height: 24,
    });
    host.registry.resizeBy(20);
    expect(host.registry.read()[0]?.frame.width).toBe(80);
    for (const layout of [
      "columns",
      "rows",
      "main-top",
      "main-left",
    ] as const) {
      host.registry.setLayout(layout);
      for (const [name, kit] of original) expect(host.kits.get(name)).toBe(kit);
      expect(host.cleaned).toEqual([]);
    }
  } finally {
    await host.dispose();
  }
});

test("repeated terminal attention is deduplicated within its pane, not across panes", async () => {
  const host = workspace();
  try {
    await host.registry.open({ kind: "fixture", name: "alpha" });
    await host.registry.open({ kind: "fixture", name: "beta" });
    for (let index = 0; index < 40; index += 1) {
      for (const name of ["alpha", "beta"])
        host.kits.get(name)?.toast({
          key: "terminal-input",
          variant: "error",
          message: "Local terminal input was not sent",
          duration: "until-dismissed",
        });
    }
    expect(host.toasts.snapshot().pending).toBe(1);
    const first = host.toasts.snapshot().current?.key;
    host.toasts.dismiss();
    expect(host.toasts.snapshot().current?.key).not.toBe(first);
    expect(host.toasts.snapshot().current?.message).toBe(
      "Local terminal input was not sent",
    );
    expect(host.toasts.snapshot().pending).toBe(0);
  } finally {
    await host.dispose();
  }
});

test("same-kind panes coexist, focus input exclusively and close independently", async () => {
  const host = workspace();
  try {
    const alpha = await host.registry.open({ kind: "fixture", name: "alpha" });
    const beta = await host.registry.open({ kind: "fixture", name: "beta" });
    expect(host.registry.read()).toHaveLength(2);
    expect(
      host.whistle
        .snapshot()
        .palette.filter((command) => command.title === "Same command"),
    ).toHaveLength(2);
    expect(host.registry.key(key("x"))).toBe(true);
    expect(host.received).toEqual(["beta:x"]);
    host.registry.paste(new PasteEvent(Buffer.from("first paste")));
    expect(host.received).toEqual(["beta:x", "beta:paste:first paste"]);
    if (alpha.kind === "refused" || beta.kind === "refused")
      throw new Error("Fixture opening refused");
    host.registry.focus(alpha.paneId);
    host.overlay.set(true);
    expect(host.registry.key(key("y"))).toBe(false);
    host.registry.paste(new PasteEvent(Buffer.from("covered paste")));
    host.overlay.set(false);
    expect(host.registry.key(key("z"))).toBe(true);
    host.registry.paste(new PasteEvent(Buffer.from("second paste")));
    expect(host.received).toEqual([
      "beta:x",
      "beta:paste:first paste",
      "alpha:z",
      "alpha:paste:second paste",
    ]);
    await host.registry.close(alpha.paneId);
    expect(host.kits.get("alpha")?.signal.aborted).toBe(true);
    expect(host.registry.read().map((pane) => pane.title)).toEqual(["beta"]);
    expect(host.registry.key(key("q"))).toBe(true);
    expect(host.received.at(-1)).toBe("beta:q");
    await host.registry.close(beta.paneId);
    expect(host.registry.read()).toEqual([]);
    expect(host.cleaned).toEqual(["alpha", "beta"]);
    expect(host.whistle.snapshot().palette).toEqual([]);
    expect(
      await host.registry.open({ kind: "fixture", name: "again" }),
    ).toHaveProperty("kind", "opened");
  } finally {
    await host.dispose();
  }
});

test("Open pane lists exactly the kinds that declare a launcher", async () => {
  const host = workspace(undefined, [probePane]);
  try {
    expect(host.registry.launchers).toEqual([
      {
        name: "Probe",
        description: "A pane built only on the Button",
        target: { kind: "probe", label: "menu" },
      },
    ]);
    const [launcher] = host.registry.launchers;
    if (launcher === undefined) throw new Error("Probe launcher missing");
    const opened = await host.registry.open(launcher.target);
    expect(opened.kind).toBe("opened");
    expect(await host.registry.open(launcher.target)).toEqual({
      kind: "focused",
      paneId: opened.kind === "opened" ? opened.paneId : "",
    });
    expect(host.registry.read().map((pane) => pane.title)).toEqual([
      "Probe menu",
    ]);
  } finally {
    await host.dispose();
  }
});

test("layout, guards and Team retirement retain the same pane ownership", async () => {
  const host = workspace();
  try {
    const alpha = await host.registry.open({ kind: "fixture", name: "alpha" });
    await host.registry.open({ kind: "fixture", name: "beta" });
    if (alpha.kind === "refused") throw new Error("Fixture opening refused");
    expect(host.registry.read().map((pane) => pane.frame.width)).toEqual([
      80, 80,
    ]);
    host.registry.viewport({ width: 40, height: 24 });
    expect(host.registry.read().filter((pane) => pane.visible)).toHaveLength(1);
    host.registry.focus(alpha.paneId);
    expect(host.registry.read().find((pane) => pane.visible)?.title).toBe(
      "alpha",
    );
    let allowClose = false;
    host.kits.get("alpha")?.guardClose(() => Promise.resolve(allowClose));
    await host.registry.close(alpha.paneId);
    expect(host.kits.get("alpha")?.signal.aborted).toBe(false);
    allowClose = true;
    await host.registry.close(alpha.paneId);
    expect(host.cleaned).toEqual(["alpha"]);
    await host.registry.dispose();
    expect(host.cleaned).toEqual(["alpha", "beta"]);
    expect(host.kits.get("beta")?.signal.aborted).toBe(true);
    expect(await host.registry.open({ kind: "fixture", name: "late" })).toEqual(
      { kind: "refused", reason: "Workspace has closed" },
    );
  } finally {
    await host.dispose();
  }
});

test("a retired pane cannot acquire input or focus", async () => {
  const host = workspace();
  const alpha = await host.registry.open({ kind: "fixture", name: "alpha" });
  if (alpha.kind === "refused") throw new Error("Fixture opening refused");
  const kit = host.kits.get("alpha");
  if (kit === undefined) throw new Error("Fixture kit missing");
  await host.registry.dispose();
  kit.input.requestFocus();
  kit.input.onKey(() => {
    throw new Error("Retired input reached pane");
  });
  expect(host.registry.key(key("x"))).toBe(false);
  expect(host.registry.read()).toEqual([]);
  expect(host.commands.active().palette).toEqual([]);
  await host.dispose();
});

test("a late acquisition is disposed without entering a replacement Team", async () => {
  const pending = Promise.withResolvers<undefined>();
  const host = workspace(() => pending.promise);
  const opening = host.registry.open({ kind: "fixture", name: "late" });
  expect(host.registry.read()[0]?.state).toBe("loading");
  const closing = host.registry.dispose();
  expect(host.kits.get("late")?.signal.aborted).toBe(true);
  pending.resolve(undefined);
  expect(await opening).toHaveProperty("kind", "refused");
  await closing;
  expect(host.cleaned).toEqual(["late"]);
  expect(host.registry.read()).toEqual([]);
  expect(host.commands.active().palette).toEqual([]);
  await host.dispose();
});

test("failed replacement keeps the usable pane and its focused commands", async () => {
  const host = workspace((name) =>
    name === "failed"
      ? Promise.reject(new Error("Acquisition denied"))
      : Promise.resolve(),
  );
  try {
    const first = await host.registry.open({ kind: "fixture", name: "first" });
    if (first.kind === "refused") throw new Error("Fixture opening refused");
    expect(
      host.registry.replace(first.paneId, { kind: "fixture", name: "failed" }),
    ).rejects.toThrow("Pane mount failed");
    expect(
      host.registry.read().map((pane) => [pane.title, pane.focused]),
    ).toEqual([["first", true]]);
    expect(host.kits.get("first")?.signal.aborted).toBe(false);
    expect(host.kits.get("failed")?.signal.aborted).toBe(true);
    host.registry.key(key("r"));
    expect(host.received).toEqual(["first:r"]);
    expect(host.cleaned).toEqual(["failed"]);
  } finally {
    await host.dispose();
  }
});

test("instance keys are isolated by registered kind", async () => {
  const host = workspace(undefined, [
    {
      kind: "other",
      instantiate: () => ({
        key: "shared",
        title: "Other kind",
        render: () => null,
      }),
    },
  ]);
  try {
    await host.registry.open({ kind: "fixture", name: "shared" });
    await host.registry.open({ kind: "other" });
    expect(host.registry.read().map((pane) => pane.title)).toEqual([
      "shared",
      "Other kind",
    ]);
  } finally {
    await host.dispose();
  }
});

test("the shell bounds pane display text and never projects terminal controls", async () => {
  const title = "Fixture\x1b]0;unsafe\x07\x9b2J" + "a".repeat(600);
  let rename: ((title: string) => void) | undefined;
  const host = workspace((_name, kit) => {
    rename = kit.setTitle;
    kit.setTitle(title);
    kit.status.contribute({
      slot: "chips",
      order: 2,
      text: "Status\x1b[2J",
      compact: "Short\x07",
      tone: "info",
    });
  });
  try {
    await host.registry.open({ kind: "fixture", name: title });
    const pane = host.registry.read()[0];
    expect(pane?.title.length).toBeLessThanOrEqual(512);
    expect(pane?.title).not.toMatch(/\p{Cc}/u);
    expect(pane?.status[1]).toMatchObject({
      text: "Status",
      compact: "Short",
    });
    if (pane === undefined || rename === undefined)
      throw new Error("Pane missing");
    rename("Renamed\x1b[2J");
    expect(host.registry.read()[0]?.title).toBe("Renamed");
    await host.registry.close(pane.paneId);
    rename("Closed pane");
    expect(host.registry.read()).toEqual([]);
  } finally {
    await host.dispose();
  }
});

test("conversation targets refuse unbounded identities before acquiring a Session", async () => {
  const { conversationPane } =
    await import("../src/panes/conversation/index.js");
  const host = workspace(undefined, [conversationPane]);
  try {
    for (const target of [
      { kind: "conversation", agentId: "a".repeat(257), sessionId: "one" },
      { kind: "conversation", agentId: "alpha", sessionId: "s".repeat(257) },
    ]) {
      expect(await host.registry.open(target)).toEqual({
        kind: "refused",
        reason: "Pane target is not supported",
      });
    }
    expect(host.registry.read()).toEqual([]);
  } finally {
    await host.dispose();
  }
});
