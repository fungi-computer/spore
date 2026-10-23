import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { stringWidth } from "bun";
import { fitHints } from "../src/button/hint-row.js";
import { Picker, PickerInline } from "../src/button/picker.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

function boldRowText(
  setup: Awaited<ReturnType<typeof testRender>>,
  label: string,
) {
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes(label));
  const line = lines[y];
  if (line === undefined) throw new Error(`Missing native row: ${label}`);
  const buffer = setup.renderer.currentRenderBuffer;
  const { attributes } = buffer.buffers;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let x = 0;
  // OpenTUI 0.5.10 getSpanLines advances by code point, not joined grapheme.
  // Observe the real native cell attributes instead of its misaligned spans.
  return Array.from(graphemes.segment(line), ({ segment }) => {
    const column = x;
    x += stringWidth(segment);
    return ((attributes[y * buffer.width + column] ?? 0) & 1) !== 0
      ? segment
      : "";
  }).join("");
}

test("native fuzzy filtering bolds the matched letters and selects the original answer", async () => {
  const selected: number[] = [];
  function Themed() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <Picker
        searchable
        choices={[
          { name: "Close pane" },
          { name: "Zoom pane", group: "Extra" },
          { name: "Open pane" },
        ]}
        collapsedGroups={["Extra"]}
        currentIndex={1}
        onSelect={(index) => selected.push(index)}
        onCancel={() => undefined}
        colors={colors}
      />
    );
  }
  const setup = await testRender(<Themed />, { width: 60, height: 20 });
  try {
    await waitForFrame(setup, (frame) => frame.includes("Close pane"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("z");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("p");
    });
    expect(setup.captureCharFrame()).toContain("Zoom pane");
    const line = setup.captureSpans().lines.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes("Zoom pane"),
    );
    expect(
      line?.spans
        .filter((span) => (span.attributes & 1) !== 0)
        .map((span) => span.text)
        .join(""),
    ).toBe("Zp");
    expect(selected).toEqual([]);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(selected).toEqual([1]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test.each([
  { choice: { name: "Cafe\u0301" }, query: "é", display: "Café", bold: "é" },
  {
    choice: { name: "👩‍💻 tools" },
    query: "👩",
    display: "👩‍💻 tools",
    bold: "👩‍💻",
  },
  {
    choice: { name: "🇺🇸 locale" },
    query: "🇺",
    display: "🇺🇸 locale",
    bold: "🇺🇸",
  },
  { choice: { name: "設定" }, query: "設", display: "設定", bold: "設" },
  {
    choice: { name: "Cafe\u0301", description: "API key" },
    query: "key",
    display: "Café",
    bold: "key",
  },
  { choice: { name: " A\t B   C" }, query: "bc", display: "A B C", bold: "BC" },
])(
  "native fuzzy paste preserves displayed graphemes and description offsets: $query",
  async ({ choice, query, display, bold }) => {
    const selected: number[] = [];
    function Themed() {
      const { colors } = useTerminalTheme("mocha");
      return (
        <Picker
          searchable
          descriptionWrap={false}
          choices={[{ name: "Skip" }, choice]}
          onSelect={(index) => selected.push(index)}
          onCancel={() => undefined}
          colors={colors}
        />
      );
    }
    const setup = await testRender(<Themed />, { width: 60, height: 20 });
    try {
      await waitForFrame(setup, (frame) => frame.includes("Skip"));
      // The maintained typeText driver splits surrogate pairs; paste emits UTF-8 intact.
      await act(async () => setup.mockInput.pasteBracketedText(query));
      await act(async () => setup.renderOnce());
      expect(boldRowText(setup, display)).toBe(bold);
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      expect(selected).toEqual([1]);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  },
);

test("truncation never bolds an ellipsis in place of a hidden match", async () => {
  function Themed() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <Picker
        searchable
        descriptionWidth={38}
        choices={[{ name: "abcdef", description: "detail" }]}
        onSelect={() => undefined}
        onCancel={() => undefined}
        colors={colors}
      />
    );
  }
  const setup = await testRender(<Themed />, { width: 46, height: 20 });
  try {
    await waitForFrame(setup, (frame) => frame.includes("a…"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("a");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("b");
    });
    const line = setup.captureSpans().lines.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes("a…"),
    );
    expect(line).toBeDefined();
    expect(
      line?.spans
        .filter((span) => (span.attributes & 1) !== 0)
        .map((span) => span.text)
        .join(""),
    ).toBe("a");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test.each([false, true])(
  "Picker ignores an out-of-range digit and commits a valid number once (searchable=%s)",
  async (searchable) => {
    const selected: number[] = [];
    function Themed() {
      const { colors } = useTerminalTheme("mocha");
      return (
        <Picker
          title="Choose"
          searchable={searchable}
          choices={[{ name: "First" }, { name: "Second" }]}
          onSelect={(index) => selected.push(index)}
          onCancel={() => undefined}
          colors={colors}
        />
      );
    }
    const setup = await testRender(<Themed />, { width: 60, height: 20 });
    try {
      await waitForFrame(setup, (frame) => frame.includes("Second"));
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("9");
      });
      expect(selected).toEqual([]);
      expect(setup.captureCharFrame()).toContain("▶ First");
      expect(setup.captureCharFrame()).toContain("Second");
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressKey("2");
      });
      expect(selected).toEqual([1]);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  },
);

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

test.each([false, true])(
  "Picker previews arrow navigation without committing (searchable=%s)",
  async (searchable) => {
    const highlighted: number[] = [];
    const selected: number[] = [];
    function Themed() {
      const { colors } = useTerminalTheme("mocha");
      return (
        <Picker
          title="Theme"
          searchable={searchable}
          choices={[{ name: "Mocha" }, { name: "Latte" }, { name: "Frappe" }]}
          currentIndex={0}
          onHighlight={(index) => highlighted.push(index)}
          onSelect={(index) => selected.push(index)}
          onCancel={() => undefined}
          colors={colors}
        />
      );
    }
    const setup = await testRender(<Themed />, { width: 60, height: 20 });
    try {
      await waitForFrame(setup, (frame) => frame.includes("Latte"));
      expect(highlighted).toEqual([]);
      expect(selected).toEqual([]);
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressArrow("down");
      });
      expect(selected).toEqual([]);
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressArrow("down");
      });
      expect(selected).toEqual([]);
      expect(highlighted).toEqual([1, 2]);
      expect(setup.captureCharFrame()).toContain("▶ Frappe");
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressArrow("up");
      });
      expect(selected).toEqual([]);
      expect(highlighted).toEqual([1, 2, 1]);
      expect(setup.captureCharFrame()).toContain("▶ Latte");
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressArrow("left");
      });
      expect(selected).toEqual([]);
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressArrow("right");
      });
      expect(selected).toEqual([]);
      expect(highlighted).toEqual([1, 2, 1]);
      await pressDecodedKey(setup, () => {
        setup.mockInput.pressEnter();
      });
      expect(selected).toEqual([1]);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  },
);

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
