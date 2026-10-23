import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TerminalClientRows } from "../src/panes/conversation/client-rows.js";
import { sigilGutterTotalWidth } from "../src/button/index.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

function Rows({ title }: Readonly<{ title: string }>) {
  const presentation = useTerminalTheme("mocha");
  return (
    <TerminalClientRows
      rows={[{ id: "goal", title, tone: "error" }]}
      presentation={presentation}
    />
  );
}

test("a wrapped footer row keeps its dot in a fixed column", async () => {
  const title =
    "Goal stalled because the kiln check keeps failing after every retry";
  const setup = await testRender(<Rows title={title} />, {
    width: 30,
    height: 6,
  });
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("●");
    const gutter = 1 + sigilGutterTotalWidth;
    for (const line of lines.slice(1))
      expect(line.slice(0, gutter).trim()).toBe("");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
