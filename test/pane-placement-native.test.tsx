import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { renderTuiConversation } from "../src/frame-renderer.js";
import type { PaneOpenPlacement } from "../src/shell/registry.js";
import type { PaneKindEntry, PaneKit } from "../src/button/index.js";
import { openTerminalApplication } from "../src/terminal-application.js";
import { createTuiFixture } from "./fixture.js";
import { probePane } from "./fixtures/probe-pane/probe-pane.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

for (const [direction, key, choice] of [
  ["beside", "v", "probe"],
  ["beside", "%", "probe"],
  ["below", "s", "probe"],
  ["below", '"', "probe"],
  ["beside", "v", "new"],
  ["below", "s", "new"],
  ["beside", "v", "resume"],
  ["below", "s", "resume"],
] as const) {
  test(`Open ${direction} (${key}, ${choice}) admits the chosen pane after the originally focused pane`, async () => {
    const setup = await testRender(<box />, { width: 384, height: 120 });
    const application = await openTerminalApplication({
      signals: { on: () => undefined, off: () => undefined },
      createQueryClient,
      createRenderer: () => Promise.resolve(setup.renderer),
      createRoot,
      createWhistle,
      enableKeymap: true,
    });
    if (application === undefined) throw new Error("Terminal did not open");
    const app = application;
    app.inputHandoff?.pause();
    let seedKit: PaneKit | undefined;
    // A real Button caller seeds several panes; it owns no placement logic.
    const seedPane: PaneKindEntry = {
      kind: "placement-seed",
      launcher: {
        name: "Seed pane",
        description: "Open the placement fixture",
        target: { kind: "placement-seed" },
      },
      instantiate: () => ({
        key: "seed",
        title: "Seed pane",
        render: (kit) => {
          seedKit = kit;
          return <text>Seed pane</text>;
        },
      }),
    };
    const fixture = createTuiFixture();
    const next = createTuiFixture({
      messages: [
        {
          id: "placed-message",
          commandId: "placed-command",
          sequence: 1,
          value: { role: "user", content: "placed-chat", timestamp: 1 },
        },
      ],
    });
    const openConversation = (openPlacement?: PaneOpenPlacement) => {
      renderTuiConversation(app.root, app.queryClient, {
        ...initial,
        session: next.session,
        openPlacement,
      });
    };
    const initial = {
      session: fixture.session,
      commands: app.commands,
      commandHost: app.commandHost,
      paneKinds: [seedPane, probePane],
      openConversation,
      chooseConversation: openConversation,
    };
    try {
      await act(async () => {
        renderTuiConversation(app.root, app.queryClient, initial);
        await setup.renderOnce();
      });
      await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
      expect(
        app.commandHost.active().palette.map((row) => row.command),
      ).toContainEqual({ namespace: "shell", id: `pane-open-${direction}` });
      await act(async () => {
        await app.commandHost.execute(
          { namespace: "shell", id: "open-app" },
          {
            origin: "programmatic",
          },
        );
      });
      await waitForFrame(setup, (frame) => frame.includes("type to filter"));
      await act(async () => {
        await setup.mockInput.typeText("Seed pane");
      });
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, () => seedKit !== undefined);
      if (seedKit === undefined) throw new Error("Seed pane did not open");
      const caller = seedKit;
      await act(async () => {
        for (const label of ["alpha", "beta", "gamma"])
          await caller.open({ kind: "probe", label });
        await caller.open({ kind: "probe", label: "beta" });
      });
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("q");
      });
      const before = setup.captureCharFrame();
      const openChooser = async () => {
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressKey("k", { ctrl: true });
        });
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressKey(key);
        });
        await waitForFrame(setup, (frame) => frame.includes("type to filter"));
      };
      await openChooser();
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEscape();
      });
      await waitForFrame(setup, (frame) => frame === before);
      await openChooser();
      await act(async () => {
        // The shared probe contributes a bare "o" command; this unique
        // prefix selects it without testing that separate admission seam.
        await setup.mockInput.typeText(
          choice === "probe" ? "Pr" : choice === "new" ? "New" : "Res",
        );
      });
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      const label = choice === "probe" ? "menu " : "placed-chat";
      const frame = await waitForFrame(setup, (text) => text.includes(label));
      expect(frame).toContain("keys:q");
      const lines = frame.split("\n");
      const betaRow = lines.findIndex((line) => line.includes("beta "));
      const menuRow = lines.findIndex((line) => line.includes(label));
      const gammaRow = lines.findIndex((line) => line.includes("gamma "));
      expect(betaRow).toBeGreaterThanOrEqual(0);
      if (direction === "beside") {
        expect(gammaRow).toBe(betaRow);
        if (choice === "probe") expect(menuRow).toBe(betaRow);
        const column = lines[menuRow]?.indexOf(label) ?? -1;
        expect((lines[betaRow] ?? "").indexOf("beta ")).toBeLessThan(column);
        expect(column).toBeLessThan((lines[gammaRow] ?? "").indexOf("gamma "));
      } else {
        expect(betaRow).toBeLessThan(menuRow);
        expect(menuRow).toBeLessThan(gammaRow);
      }
    } finally {
      await act(async () => {
        await app.close();
      });
    }
  });
}
