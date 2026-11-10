import { test, expect } from "bun:test";
import { captureFrame } from "./frame-capture.js";
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

for (const [width, height] of [
  [60, 20],
  [80, 24],
  [100, 32],
  [120, 40],
  [160, 48],
] as const) {
  test(`key help is readable at ${String(width)}x${String(height)}`, async () => {
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
      height,
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
      const ids = catalog.palette.map((row) => row.command.id);
      expect(ids).toContain("new");
      expect(ids).toContain("theme");
      expect(ids).not.toContain("help");
      expect(ids).not.toContain("keys");
      expect(ids).not.toContain("account");
      expect(catalog.palette.map((row) => row.command)).not.toContainEqual({
        namespace: "shell",
        id: "pane-open",
      });
      expect(catalog.palette.some((row) => row.title === "Show commands")).toBe(
        false,
      );
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("k", { ctrl: true });
      });
      const hints = await waitForFrame(setup, (frame) =>
        frame.includes("All commands"),
      );
      const paneBindings = [
        ["Open pane", "o"],
        ["Close pane", "x"],
        ["Zoom pane", "z"],
        ["Focus left", "h"],
        ["Focus right", "l"],
        ["Move pane left", "{"],
        ["Move pane right", "}"],
        ["All commands", ":"],
      ] as const;
      expect(hints).not.toContain("↑↓ choose");
      for (const [title, key] of paneBindings)
        expect(hints).toContain(`${key} ${title}`);

      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEscape();
      });
      await act(async () => setup.mockInput.typeText("/keys"));
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, (frame) => frame.includes("Key bindings"));
      expect(setup.captureCharFrame()).not.toContain("/keys");
      expect(setup.captureCharFrame().replace(/\s+/gu, " ")).toContain(
        "Open pane Ctrl K o",
      );
      for (const [search, expected] of [
        ["All commands", "Ctrl K Ctrl K"],
        ["Next layout", "Ctrl K Space"],
        ["Show service status", "Available only during service recovery."],
        ["Zoom pane", "newline in the composer"],
      ] as const) {
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressKey("u", { ctrl: true });
        });
        await act(async () => setup.mockInput.typeText(search));
        await act(async () => setup.renderOnce());
        const help = setup.captureCharFrame();
        expect(help.replace(/\s+/gu, "")).toContain(
          expected.replace(/\s+/gu, ""),
        );
        expect(help).not.toContain("<leader>");
        await captureFrame(
          setup,
          process.env.TUI_SPLIT_CAPTURE_DIR,
          `keys-${search.replaceAll(" ", "-")}-${String(width)}x${String(height)}`,
        );
      }
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEscape();
      });
      await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
      // The 60x20 audit adds help coverage; retain palette/recents coverage at larger sizes.
      if (width === 60) return;
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
      expect(setup.captureCharFrame()).toContain("Grow main pane");
      await act(async () => setup.mockInput.typeText("lette"));
      await waitForFrame(setup, (frame) =>
        frame.includes("Preview the palette"),
      );
      expect(setup.captureCharFrame()).toContain("ADVANCED");
      expect(setup.captureCharFrame()).not.toContain("Grow main pane");
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
