import { test, expect } from "bun:test";
import { createRoot } from "@opentui/react";
import { openTerminalApplication } from "../src/terminal-application.js";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture, fixtureClients } from "./fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

for (const width of [80, 160]) {
  test(`the shell and /help share the searchable palette and successful recents at ${String(width)} columns`, async () => {
    const fixture = createTuiFixture();
    const commands = createWhistle();
    let executions = 0;
    commands.contribute({
      sourceId: "palette-fixture",
      namespace: "palette-fixture",
      commands: [
        ...["Second preview", "Third preview"].map((title) => ({
          id: title,
          title,
          category: "Advanced",
          projections: { palette: { order: 50 } },
          handler: () => {
            executions += 1;
          },
        })),
        {
          id: "preview",
          title: "Preview the palette",
          category: "Advanced",
          projections: { palette: { order: 50 } },
          handler: () => {
            executions += 1;
          },
        },
      ],
    });
    const setup = await testRender(<box />, {
      width,
      height: width === 80 ? 24 : 48,
    });
    const application = await openTerminalApplication({
      signals: { on: () => undefined, off: () => undefined },
      createQueryClient,
      createRenderer: () => Promise.resolve(setup.renderer),
      createRoot,
      createWhistle: () => commands,
      enableKeymap: true,
    });
    if (application === undefined) throw new Error("Terminal did not open");
    application.inputHandoff?.pause();
    act(() => {
      application.root.render(
        <QueryClientProvider client={application.queryClient}>
          <TuiFrame
            session={fixture.session}
            clients={fixtureClients}
            commands={commands}
            commandHost={application.commandHost}
            initialTheme="mocha"
          />
        </QueryClientProvider>,
      );
    });
    try {
      await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
      expect(setup.captureCharFrame()).not.toMatch(/Mod\+K|<leader>/u);
      const catalog = commands.snapshot();
      for (const row of [...catalog.palette, ...catalog.slash]) {
        expect(["Conversation", "Settings", "Panes", "Advanced"]).toContain(
          row.category,
        );
        expect(row.title.length).toBeLessThanOrEqual(32);
        expect(row.description ?? "").not.toMatch(
          /Null|preference|projection|session_fact/u,
        );
      }
      const ids = catalog.palette.map((row) => row.commandId);
      expect(ids.some((id) => id.endsWith(":tui/new"))).toBe(true);
      expect(ids.some((id) => id.endsWith(":tui/theme"))).toBe(true);
      expect(
        ids.some(
          (id) =>
            id.endsWith("/help") ||
            id.endsWith("/keys") ||
            id.endsWith("/account"),
        ),
      ).toBe(false);
      expect(ids).not.toContain("shell:pane-open");
      expect(catalog.palette.some((row) => row.title === "Show commands")).toBe(
        false,
      );
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("k", { ctrl: true });
      });
      await waitForFrame(setup, (frame) => frame.includes("All commands"));
      const paneRows = setup
        .captureCharFrame()
        .split("\n")
        .filter((line) =>
          [
            "Open pane",
            "Close pane",
            "Zoom pane",
            "Focus left",
            "Focus right",
            "Move pane left",
            "Move pane right",
            "All commands",
          ].some((title) => line.includes(title)),
        );
      expect(paneRows).toHaveLength(8);
      for (const [index, title] of [
        "Open pane",
        "Close pane",
        "Zoom pane",
        "Focus left",
        "Focus right",
        "Move pane left",
        "Move pane right",
        "All commands",
      ].entries()) {
        expect(paneRows[index]).toContain(title);
        expect(paneRows[index]?.trimEnd().at(-1)).toBe(
          ["o", "x", "z", "h", "l", "{", "}", ":"][index],
        );
      }

      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEscape();
      });
      await act(async () => setup.mockInput.typeText("/keys"));
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, (frame) => frame.includes("Key bindings"));
      const openBinding = setup
        .captureCharFrame()
        .split("\n")
        .find(
          (line) => line.includes("Open pane") && line.includes("Ctrl K o"),
        );
      expect(openBinding).toBeDefined();
      expect(openBinding?.indexOf("Open pane")).toBeLessThan(
        openBinding?.indexOf("Ctrl K o") ?? 0,
      );
      expect(openBinding?.trimEnd()).toEndWith("Ctrl K o");
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEscape();
      });
      await act(async () => {
        await setup.mockInput.pressKeys(Array.from("/keys", () => "BACKSPACE"));
      });
      await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("k", { ctrl: true });
      });
      await waitForFrame(setup, (frame) => frame.includes("All commands"));
      await act(async () => setup.mockInput.typeText(":"));
      await waitForFrame(setup, (frame) => frame.includes("More commands"));
      expect(setup.captureCharFrame()).toContain("type to filter");
      expect(setup.captureCharFrame()).not.toContain("Preview the palette");
      await act(async () => setup.mockInput.typeText("pa"));
      await waitForFrame(setup, (frame) => frame.includes("PANES"));
      expect(setup.captureCharFrame()).toContain("Split panes");
      await act(async () => setup.mockInput.typeText("lette"));
      await waitForFrame(setup, (frame) =>
        frame.includes("Preview the palette"),
      );
      expect(setup.captureCharFrame()).toContain("ADVANCED");
      expect(setup.captureCharFrame()).not.toContain("Split panes");
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, () => executions === 1);
      await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
      for (const [index, title] of [
        "Second preview",
        "Third preview",
      ].entries()) {
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressKey("k", { ctrl: true });
        });
        await waitForFrame(setup, (frame) => frame.includes("All commands"));
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressKey("k", { ctrl: true });
        });
        await waitForFrame(setup, (frame) => frame.includes("type to filter"));
        await act(async () => setup.mockInput.typeText(title));
        await waitForFrame(setup, (frame) => frame.includes(title));
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressEnter();
        });
        await waitForFrame(setup, () => executions === index + 2);
        await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
      }
      await act(async () => setup.mockInput.typeText("/help"));
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, (frame) => frame.includes("RECENT"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Preview the palette");
      expect(frame).toContain("Second preview");
      expect(frame).toContain("Third preview");
      expect(frame).toContain("type to filter");
      expect(frame).toContain("More commands");
      expect(frame).not.toContain("/model");
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEscape();
      });
      expect(executions).toBe(3);
    } finally {
      await act(async () => application.close());
    }
  });
}
