import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { awaitingFixtures } from "@fungi.computer/parakeet-testing";
import {
  decisionView,
  decisionViewText,
} from "@fungi.computer/parakeet/headless";
import { DecisionBox } from "../src/button/decision-box.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";

function Box({
  fixture,
  width,
  height,
}: Readonly<{
  fixture: (typeof awaitingFixtures)[number];
  width: number;
  height: number;
}>) {
  const { colors } = useTerminalTheme("mocha");
  return (
    <DecisionBox
      view={decisionView(fixture.state, fixture.prompt, {
        kind: fixture.kind,
        position: fixture.position,
        total: fixture.total,
      })}
      dispatch={() => undefined}
      colors={colors}
      surface={colors.surface}
      width={width}
      rows={height}
      active
    />
  );
}

for (const [width, height] of [
  [120, 36],
  [60, 24],
] as const)
  for (const fixture of awaitingFixtures)
    test(`the terminal composer draws exactly decisionView for ${fixture.name} at ${String(width)}x${String(height)}`, async () => {
      const view = decisionView(fixture.state, fixture.prompt, {
        kind: fixture.kind,
        position: fixture.position,
        total: fixture.total,
      });
      const setup = await testRender(
        <Box fixture={fixture} width={width} height={height} />,
        { width, height },
      );
      try {
        await act(async () => setup.renderOnce());
        const lines = setup
          .captureCharFrame()
          .split("\n")
          // Facts sit in a label column; a space is a space either way.
          .map((line) => line.trim().replace(/ {2,}/gu, " "));
        // Wrapped text reads as one run.
        const frame = lines.join(" ");
        let from = 0;
        // The count closes the title line at every width.
        for (const token of decisionViewText(view)) {
          let shown = token;
          let at = frame.indexOf(shown, from);
          // A cramped terminal cuts a long sentence with an ellipsis; its start must show.
          if (at < 0 && width <= 60 && token.length > 30) {
            shown = token.slice(0, 30);
            at = frame.indexOf(shown, from);
          }
          expect(
            at,
            `"${token}" after offset ${String(from)} in:\n${lines.join("\n")}`,
          ).toBeGreaterThanOrEqual(0);
          from = at + shown.length;
        }
        for (const hint of view.hints.slice(0, 1))
          expect(frame).toContain(hint.keys);
        const lit = lines.filter((line) => line.startsWith("›"));
        expect(lit).toHaveLength(1);
        expect(lit[0]).toContain(
          view.rows.find((row) => row.highlighted)?.text ?? "",
        );
      } finally {
        await destroyTestRenderer(setup);
      }
    });
