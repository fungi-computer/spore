import { expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import { CodeRenderable, TextRenderable, type Renderable } from "@opentui/core";
import { TerminalMarkdownBlocks } from "../src/button/terminal-markdown.js";
import {
  ToolSectionView,
  ToolGroupRow,
} from "../src/panes/conversation/transcript.js";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { Picker } from "../src/button/picker.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import type { TuiPresentation } from "../src/button/presentation.js";
import { initialToolDisclosure } from "@fungi.computer/parakeet/headless";
import type {
  MarkdownBlock,
  ParakeetToolCallSection,
} from "@fungi.computer/parakeet/headless";

const hostileDisplayText =
  "safe\u001b]0;forged\u0007\u001b]52;c;Y21k\u0007\u001b[2J\u009d\u0090\u009c\u009b2J\r\u202e end";
const unsafe = /[^\P{Cc}\n\t]|[\u202a-\u202e\u2066-\u2069]/u;
function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}
const sections: readonly [string, ParakeetToolCallSection][] = [
  [
    "match location",
    {
      kind: "matches",
      preview: 1,
      matches: [{ location: hostileDisplayText, text: "matched" }],
    },
  ],
  [
    "match text",
    {
      kind: "matches",
      preview: 1,
      matches: [{ location: "file:1", text: hostileDisplayText }],
    },
  ],
  [
    "section label",
    { kind: "text", preview: 1, label: hostileDisplayText, lines: ["body"] },
  ],
];
const blocks: readonly [string, MarkdownBlock][] = [
  [
    "href",
    {
      type: "paragraph",
      children: [
        {
          type: "link",
          href: hostileDisplayText,
          children: [{ type: "text", value: "safe link" }],
        },
      ],
    },
  ],
  [
    "image",
    {
      type: "paragraph",
      children: [
        { type: "image", src: hostileDisplayText, alt: hostileDisplayText },
      ],
    },
  ],
  [
    "code title",
    {
      type: "code",
      value: "safe body",
      title: hostileDisplayText,
      lang: "text",
    },
  ],
  [
    "callout title",
    { type: "callout", kind: "note", title: hostileDisplayText, children: [] },
  ],
];
const entries: readonly [
  string,
  (presentation: TuiPresentation) => ReactNode,
][] = [
  ...sections.map(
    ([name, section]): [string, (p: TuiPresentation) => ReactNode] => [
      name,
      (p) => (
        <ToolSectionView section={section} presentation={p} full width={100} />
      ),
    ],
  ),
  ...blocks.map(
    ([name, block]): [string, (p: TuiPresentation) => ReactNode] => [
      name,
      (p) => (
        <TerminalMarkdownBlocks
          nodes={[block]}
          presentation={p}
          foreground={p.colors.foreground}
          streaming={false}
        />
      ),
    ],
  ),
  [
    "group summary",
    (p) => (
      <ToolGroupRow
        group={{
          id: "group",
          kind: "tool_group",
          summary: hostileDisplayText,
          calls: [],
          tools: [],
          failedCount: 0,
          status: "completed",
        }}
        presentation={p}
        disclosure={initialToolDisclosure}
        inset={0}
        terminalWidth={100}
        toggle={() => undefined}
      />
    ),
  ],
  [
    "picker title, name, description, group",
    (p) => (
      <Picker
        colors={p.colors}
        title={hostileDisplayText}
        choices={[
          {
            name: hostileDisplayText,
            description: hostileDisplayText,
            group: hostileDisplayText,
          },
        ]}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />
    ),
  ],
];
for (const [name, render] of entries) {
  test(`native display boundary rejects terminal programs in ${name}`, async () => {
    function View() {
      return render(useTerminalTheme("mocha"));
    }
    const setup = await testRender(<View />, { width: 100, height: 30 });
    try {
      await act(async () => setup.renderOnce());
      await act(async () => setup.renderOnce());
      for (const node of descendants(setup.renderer.root)) {
        if (node instanceof CodeRenderable) await node.highlightingDone;
        if (node instanceof TextRenderable) {
          expect(node.plainText).not.toMatch(unsafe);
          for (const chunk of node.chunks) {
            expect(chunk.text).not.toMatch(unsafe);
            expect(chunk.link?.url ?? "").not.toMatch(unsafe);
          }
        }
      }
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("safe");
      expect(setup.captureCharFrame()).not.toMatch(unsafe);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}

for (const character of ["\u2060", "\ufeff"]) {
  test(`native markdown keeps the visible suffix after ${String(character.codePointAt(0))}`, async () => {
    const payload = `run safe${character.repeat(6)}; evil|`;
    function View() {
      const p = useTerminalTheme("mocha");
      return (
        <TerminalMarkdownBlocks
          nodes={[
            { type: "paragraph", children: [{ type: "text", value: payload }] },
          ]}
          presentation={p}
          foreground={p.colors.foreground}
          streaming={false}
        />
      );
    }
    const setup = await testRender(<View />, { width: 100, height: 10 });
    try {
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("run safe; evil|");
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}

test("picker collapses a group with CR and bidi and expands its actual choices", async () => {
  const group = "Extras\r\u202e group";
  function View() {
    const p = useTerminalTheme("mocha");
    return (
      <DialogSurface colors={p.colors} onClose={() => undefined}>
        <Picker
          colors={p.colors}
          searchable
          collapsedGroups={[group]}
          choices={[{ name: "hidden choice", group }]}
          onCancel={() => undefined}
          onSelect={() => undefined}
        />
      </DialogSurface>
    );
  }
  const setup = await testRender(<View />, { width: 100, height: 20 });
  try {
    await act(async () => setup.renderOnce());
    await act(async () => setup.renderOnce());
    const nativeText = () =>
      descendants(setup.renderer.root)
        .flatMap((node) =>
          node instanceof TextRenderable ? [node.plainText] : [],
        )
        .join("\n");
    expect(nativeText()).not.toContain("hidden choice");
    expect(nativeText()).toContain("(1)…");
    act(() => {
      setup.mockInput.pressEnter();
    });
    await act(async () => setup.renderOnce());
    await act(async () => setup.renderOnce());
    expect(nativeText()).toContain("hidden choice");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
