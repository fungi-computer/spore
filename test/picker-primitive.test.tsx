import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { stringWidth } from "bun";
import { fitHints } from "../src/button/hint-row.js";
import { Picker, PickerInline } from "../src/button/picker.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

test("HintRow drops the least important hints first and keeps their order", () => {
  const hints = [
    { keys: "↑↓", label: "choose", priority: 1 },
    { keys: "Enter", label: "select", priority: 0 },
    { keys: "Esc", label: "cancel", priority: 2 },
  ];
  expect(fitHints(hints, 80)).toEqual(hints);
  expect(fitHints(hints, 29).map((hint) => hint.keys)).toEqual(["↑↓", "Enter"]);
  expect(fitHints(hints, 12).map((hint) => hint.keys)).toEqual(["Enter"]);
  expect(fitHints(hints, 16, true).map((hint) => hint.keys)).toEqual([
    "↑↓",
    "Enter",
    "Esc",
  ]);
  expect(fitHints(hints, 3)).toEqual([]);
});

test("Picker reports each highlighted choice for live preview, not its mount", async () => {
  const highlighted: number[] = [];
  function Themed() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <Picker
        title="Theme"
        choices={[{ name: "Mocha" }, { name: "Latte" }, { name: "Frappe" }]}
        currentIndex={0}
        onHighlight={(index) => highlighted.push(index)}
        onSelect={() => undefined}
        onCancel={() => undefined}
        colors={colors}
      />
    );
  }
  const setup = await testRender(<Themed />, { width: 60, height: 20 });
  try {
    await waitForFrame(setup, (frame) => frame.includes("Latte"));
    expect(highlighted).toEqual([]);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    expect(highlighted).toEqual([1, 2]);
    expect(setup.captureCharFrame()).toContain("▶ Frappe");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("inline Picker rows (slash completion) cut wide glyphs by terminal cells", async () => {
  const wide = "設定設定設定設定設定設定";
  const width = 40;
  function Inline() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <PickerInline
        rows={[
          {
            key: "wide",
            label: `/${wide}`,
            detail: `${wide}${wide}${wide}`,
          },
        ]}
        selected={0}
        onChoose={() => undefined}
        colors={colors}
        maxRows={4}
        width={width}
      />
    );
  }
  const setup = await testRender(<Inline />, { width: 80, height: 6 });
  try {
    await act(async () => setup.renderOnce());
    const line = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("設"));
    expect(line).toBeDefined();
    expect(line).toContain("…");
    expect(stringWidth((line ?? "").trimEnd())).toBeLessThanOrEqual(width + 1);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
