import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import type { ThemeName } from "../src/button/theme-preferences.js";

function Window({ theme }: Readonly<{ theme: ThemeName }>) {
  const { colors } = useTerminalTheme(theme);
  return (
    <DialogSurface colors={colors} onClose={() => undefined}>
      <text fg={colors.foreground}>Window content</text>
    </DialogSurface>
  );
}

const themes: readonly ThemeName[] = ["mocha", "latte"];
for (const theme of themes) {
  for (const size of [
    { width: 80, height: 30, panelWidth: 68 },
    { width: 48, height: 24, panelWidth: 46 },
  ]) {
    test(`borderless dialog padding shares the content background in ${theme} at ${String(size.width)} columns`, async () => {
      const setup = await testRender(<Window theme={theme} />, size);
      try {
        await act(async () => setup.renderOnce());
        const text = setup.captureCharFrame();
        expect(text).not.toMatch(/[\u2500-\u257f]/u);
        const lines = text.split("\n");
        const contentRow = lines.findIndex((line) =>
          line.includes("Window content"),
        );
        const left = (size.width - size.panelWidth) / 2;
        const right = left + size.panelWidth - 1;
        expect(lines[contentRow]?.indexOf("Window content")).toBe(left + 2);
        const frame = setup.captureSpans();
        const content = frame.lines
          .flatMap((line) => line.spans)
          .find((span) => span.text.includes("Window content"));
        if (content === undefined) throw new Error("Missing dialog content");
        // One blank row above and below, two columns of horizontal padding.
        for (const row of frame.lines.slice(contentRow - 1, contentRow + 2)) {
          let column = 0;
          for (const span of row.spans) {
            if (column <= right && column + span.width > left)
              expect(span.bg.toInts()).toEqual(content.bg.toInts());
            column += span.width;
          }
        }
      } finally {
        act(() => {
          setup.renderer.destroy();
        });
      }
    });
  }
}
