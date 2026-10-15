import { mkdir } from "node:fs/promises";
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { sigilGutterTotalWidth } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import { loadToolSigils } from "../src/tool-sigils.js";
import { createTuiFixture, fixtureClients } from "./fixture.js";
import { groupedToolsDesignSnapshot } from "./design-fixture.js";
import { captureFrame } from "./frame-capture.js";
import { captureCells, captureSigilPlacements } from "./frame-cells.js";

// Every row's inset is 1. The footer dot never moves: it stays the one
// cell it always occupied. A tool icon's image now spans three columns --
// one reclaimed from the pane's own left inset, plus the existing
// two-cell gutter -- so its own origin sits one cell before the dot's;
// the uploaded artwork is pre-composited (build-tool-sigils.mjs) so its
// opaque center, not its origin, is what actually lines up with the
// dot's center. That numeric proof (measured in real rendered pixels,
// both axes, within 1px) lives in the receipts this fix shipped with,
// not here -- this native test only has character-cell granularity, so
// it can confirm the columns each occupy, not sub-cell alignment.
const iconOriginX = 0;
const dotX = 1;
const textX = 1 + sigilGutterTotalWidth;

for (const width of [80, 160])
  test(`timeline and footer sigils share one centered left gutter (${String(width)} cols)`, async () => {
    const sigils = await loadToolSigils(() => undefined);
    // Drop the one failing, auto-expanded call: the screenshot shows
    // ordinary tool rows next to the footer, not a failure's output.
    const messages = groupedToolsDesignSnapshot.messages.filter(
      (message) => !message.id.includes("group-test"),
    );
    const fixture = createTuiFixture({
      messages,
      loop: {
        loopId: "sigil-gutter",
        origin: "human",
        expiresAt: null,
        prompt: "Keep watching the build",
        mode: "self_paced",
        cron: null,
        state: "active",
        commandId: "sigil-gutter-work",
        reason: "Waiting",
        nextDueAt: null,
        lastError: null,
      },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const commands = createWhistle();
    const setup = await testRender(
      <QueryClientProvider client={client}>
        <TuiFrame
          session={fixture.session}
          commands={commands}
          clients={fixtureClients}
          toolSigils={sigils}
          initialTheme="mocha"
        />
      </QueryClientProvider>,
      { width, height: width === 80 ? 24 : 36 },
    );
    try {
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("Loop · active")),
      );
      await act(async () => setup.renderOnce());
      const output = process.env.TUI_SIGIL_GUTTER_CAPTURE_DIR;
      if (output !== undefined) {
        await mkdir(output, { recursive: true });
        await captureFrame(setup, output, `sigil-gutter-${String(width)}`);
      }
      const frame = captureCells(setup);
      const placements = captureSigilPlacements(frame);
      expect(placements.length).toBeGreaterThan(0);
      // Every timeline tool icon's image starts in the same reclaimed
      // column, one cell before the dot's own column.
      for (const origin of placements) expect(origin.x).toBe(iconOriginX);
      const footerRowY = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Loop · active"));
      expect(footerRowY).toBeGreaterThanOrEqual(0);
      // The footer's own dot never moved: still its one unchanged cell,
      // lining up with the timeline's sigils instead of sitting flush
      // left with no gutter at all, as the ordinary footer row used to.
      const footerDot = frame.cells.find(
        (cell) => cell.y === footerRowY && cell.text === "●",
      );
      expect(footerDot?.x).toBe(dotX);
      expect(
        frame.cells.find((cell) => cell.y === footerRowY && cell.x === textX)
          ?.text,
      ).toBe("L");
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      client.clear();
      commands.close();
      await fixture.waitForClose();
    }
  });
