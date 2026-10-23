import { expect, test } from "bun:test";
import { act } from "react";
import { mkdir } from "node:fs/promises";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import { themeNames } from "../src/button/theme-preferences.js";
import {
  createDesignTuiFixture,
  groupedToolsDesignSnapshot,
} from "./design-fixture.js";
import { captureFrame } from "./frame-capture.js";

for (const theme of themeNames)
  test(`native chat selection uses a readable inverse pair in ${theme}`, async () => {
    const fixture = createDesignTuiFixture({
      snapshot: {
        ...groupedToolsDesignSnapshot,
        messages: groupedToolsDesignSnapshot.messages.slice(0, 2),
      },
    });
    const query = createQueryClient();
    const commands = createWhistle();
    const setup = await testRender(
      <QueryClientProvider client={query}>
        <TuiFrame
          session={fixture.session}
          commands={commands}
          initialTheme={theme}
        />
      </QueryClientProvider>,
      { width: 80, height: 24 },
    );
    try {
      await act(async () =>
        setup.waitForFrame((frame) =>
          frame.includes("I’ll read the transcript"),
        ),
      );
      const lines = setup.captureCharFrame().split("\n");
      const y = lines.findIndex((line) =>
        line.includes("I’ll read the transcript"),
      );
      const x = lines[y]?.indexOf("read") ?? -1;
      expect(x).toBeGreaterThanOrEqual(0);
      const cell = () => {
        const row = setup.captureSpans().lines[y];
        let column = 0;
        for (const span of row?.spans ?? []) {
          if (x < column + span.width) return span;
          column += span.width;
        }
        throw new Error("Missing chat cell");
      };
      const before = cell();
      await act(async () => {
        await setup.mockMouse.pressDown(x, y);
        await setup.mockMouse.moveTo(x + 18, y);
        await setup.renderOnce();
      });
      expect(setup.renderer.hasSelection).toBe(true);
      const selected = cell();
      expect(selected.bg.toInts()).toEqual(before.fg.toInts());
      expect(selected.fg.toInts()).toEqual(before.bg.toInts());
      expect(selected.bg.toInts()).not.toEqual(before.bg.toInts());
      const output = process.env.TUI_SELECTION_CAPTURE_DIR;
      if (output) {
        await mkdir(output, { recursive: true });
        await captureFrame(setup, output, `${theme}-80x24-selection`);
      }
      setup.renderer.clearSelection();
      await act(async () => setup.mockMouse.release(x + 18, y));
    } finally {
      await destroyTestRenderer(setup);
      query.clear();
      commands.close();
    }
  });
