import { expect, test } from "bun:test";
import { act } from "react";
import { ScrollBoxRenderable, RGBA, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { sigilGutterTotalWidth } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import {
  createDesignTuiFixture,
  groupedToolsDesignSnapshot,
} from "./design-fixture.js";
import { captureFrame } from "./frame-capture.js";
import { captureCells, captureSigilPlacements } from "./frame-cells.js";

// Every row's inset is 1; a tool icon's own image spans three columns --
// the pane's own left inset (reclaimed, so it starts at the pane's true
// left edge) plus the existing two-cell gutter -- so its origin sits one
// cell before the inset, and the glyph fills all three columns with no
// pad, ending exactly where the row's text always started.
const sigilX = 0;
const textX = 1 + sigilGutterTotalWidth;

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}

const glyph = {
  text: "\u{10eeee}\u0305\u0305\u{10eeee}\u0305\u030d\u{10eeee}\u0305\u030e",
  color: RGBA.fromInts(0, 240, 1),
};
for (const width of [80, 160]) {
  for (const enabled of [false, true]) {
    test(`run sigils use ordinary placeholder cells only when enabled (${String(width)}, ${String(enabled)})`, async () => {
      const fixture = createDesignTuiFixture({
        snapshot: groupedToolsDesignSnapshot,
      });
      const query = createQueryClient();
      const commands = createWhistle();
      const setup = await testRender(
        <QueryClientProvider client={query}>
          <TuiFrame
            session={fixture.session}
            commands={commands}
            toolSigils={
              enabled
                ? {
                    code: glyph,
                    command: glyph,
                    edit: glyph,
                    error: glyph,
                    other: glyph,
                    read: glyph,
                    search: glyph,
                  }
                : undefined
            }
            initialTheme="mocha"
          />
        </QueryClientProvider>,
        { width, height: 72 },
      );
      try {
        await act(async () =>
          setup.waitForFrame((frame) => frame.includes("read")),
        );
        expect(setup.captureCharFrame().includes("\u{10eeee}")).toBe(enabled);
        const frame = captureCells(setup);
        const rows = setup
          .captureCharFrame()
          .split("\n")
          .filter((row) => /[▸▾]\s*$/u.test(row));
        // The failed fixture opens its summary and all six call rows.
        expect(rows).toHaveLength(7);
        const placements = captureSigilPlacements(frame);
        expect(placements).toHaveLength(enabled ? 7 : 0);
        const messageY = setup
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes("I’ll read the transcript"));
        expect(messageY).toBeGreaterThanOrEqual(0);
        expect(
          frame.cells.find((cell) => cell.y === messageY && cell.x === textX)
            ?.text,
        ).toBe("I");
        const toolRowYs = frame.cells
          .filter((cell) => cell.text === "▸" || cell.text === "▾")
          .map((cell) => cell.y);
        expect(toolRowYs).toHaveLength(7);
        for (const [index, y] of toolRowYs.entries()) {
          const cells = frame.cells.filter((cell) => cell.y === y);
          // The whole three-column span an icon's own image fills -- one
          // reclaimed from the pane's left inset, plus the existing
          // two-cell gutter -- is blank when there is no sigil, and the
          // glyph fills it exactly (its own width) when there is.
          const gutter = cells.filter((cell) => cell.x >= 0 && cell.x < textX);
          expect(gutter.map((cell) => cell.text).join("")).toBe(
            enabled ? glyph.text : "   ",
          );
          if (enabled) {
            const sigilCells = gutter.filter(
              (cell) => cell.x >= sigilX && cell.x < sigilX + 3,
            );
            for (const cell of sigilCells) {
              expect(cell.width).toBe(1);
              expect(cell.fg.slice(0, 3)).toEqual([0, 240, 1]);
            }
          }
          const captions = [
            "Read 2 files",
            "Read apps/tui/src/frame.tsx",
            "Read apps/tui/src/transcript.tsx",
            "Searched ToolRow",
            "Updated apps/tui/src/transcript.tsx",
            "Ran pnpm --dir apps/tui run test",
            "Ran pnpm --dir apps/tui run typecheck",
          ];
          expect(
            cells
              .filter((cell) => cell.x >= textX)
              .map((cell) => cell.text)
              .join("")
              .startsWith(captions[index] ?? "missing fixture row"),
          ).toBe(true);
          const origins = placements.filter((cell) => cell.y === y);
          expect(origins).toHaveLength(enabled ? 1 : 0);
          if (enabled) expect(origins[0]?.x).toBe(sigilX);
          const statuses = cells.filter((cell) => cell.text === "●");
          expect(statuses.map((cell) => cell.x)).toEqual([width - 4]);
          const status = statuses[0];
          if (status === undefined) throw new Error("Missing tool status dot");
          expect(status.attributes).toBe(0);
          // The failed group summary and failed test call are red; successful calls are green.
          if (index === 5)
            expect(cells.map((cell) => cell.text).join("")).toContain(
              "Ran pnpm --dir apps/tui run test",
            );
          expect(status.fg.slice(0, 3)).toEqual(
            index === 0 || index === 5 ? [243, 139, 168] : [166, 227, 161],
          );
          expect(cells.filter((cell) => /[✓✗◌]/u.test(cell.text))).toHaveLength(
            0,
          );
        }
        if (!enabled && process.env.TUI_TOOL_LAYOUT_CAPTURE_DIR) {
          await act(async () => {
            const lines = setup.captureCharFrame().split("\n");
            const y = lines.findIndex((line) =>
              line.includes("Ran pnpm --dir apps/tui run test"),
            );
            if (y < 0) throw new Error("Missing failed tool row");
            await setup.mockMouse.click(lines[y]?.indexOf("Ran") ?? 0, y);
            setup.renderer.resize(width, width === 80 ? 24 : 48);
            await setup.renderOnce();
          });
          await captureFrame(
            setup,
            process.env.TUI_TOOL_LAYOUT_CAPTURE_DIR,
            `tools-${String(width)}`,
          );
        }
        for (const row of rows) {
          expect(row).toMatch(/● [▸▾]\s*$/u);
          const prefix = enabled ? glyph.text : " ".repeat(textX);
          expect(row.startsWith(prefix)).toBe(true);
          expect(row.slice(prefix.length)).toMatch(/^[A-Z]/u);
        }
        const columns = rows.map((row) =>
          Bun.stringWidth(
            row.slice(0, Math.max(row.indexOf("▸"), row.indexOf("▾"))),
          ),
        );
        expect(new Set(columns).size).toBe(1);
        expect(columns[0]).toBe(width - 2);
        if (enabled) {
          const scroll = descendants(setup.renderer.root).find(
            (node) => node instanceof ScrollBoxRenderable,
          );
          if (!(scroll instanceof ScrollBoxRenderable))
            throw new Error("Missing transcript scroll owner");
          await act(async () => {
            setup.renderer.resize(width, 18);
            scroll.scrollTo(0);
            await setup.renderOnce();
          });
          const top = setup.captureCharFrame();
          await act(async () => {
            scroll.scrollTo(scroll.scrollHeight);
            await setup.renderOnce();
          });
          const bottom = setup.captureCharFrame();
          expect(bottom).not.toBe(top);
          expect(bottom.includes("\u{10eeee}")).toBe(true);
          expect(
            bottom.split("\n").every((row) => Bun.stringWidth(row) <= width),
          ).toBe(true);
        }
      } finally {
        act(() => {
          setup.renderer.destroy();
        });
        query.clear();
        commands.close();
      }
    });
  }
}
