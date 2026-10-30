import { expect, spyOn, test } from "bun:test";
import {
  CodeRenderable,
  TextAttributes,
  TextRenderable,
  TextTableRenderable,
  type Renderable,
} from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { CopySurface } from "../src/button/copy-surface.js";
import { TerminalMarkdown } from "../src/button/terminal-markdown.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}

function Markdown({
  content,
  streaming = false,
}: Readonly<{ content: string; streaming?: boolean }>) {
  const presentation = useTerminalTheme("mocha");
  return (
    <TerminalMarkdown
      content={content}
      streaming={streaming}
      presentation={presentation}
      foreground={presentation.colors.foreground}
    />
  );
}

test("shared Markdown draws styled prose, lists, tables and literal source safely", async () => {
  const source = [
    "---",
    "This is conversation text, not document metadata.",
    "---",
    "",
    "# A heading",
    "",
    "A **strong** and *gentle* answer with ~~old~~ text, `inline code`, and [a link](https://example.com).",
    "",
    "- [x] Finished",
    "- [ ] Waiting",
    "",
    "- Parent item",
    "  - Nested item",
    "",
    "> Quoted answer",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| sample | **42** |",
    "",
    "\\*literal stars\\*",
    "",
    "![Diagram](https://example.com/diagram.png)",
    "",
    "<script>visible source</script>",
    "",
    '```ts title="sample.ts"',
    "const answer = 42;",
    "```",
  ].join("\n");
  const setup = await testRender(<Markdown content={source} />, {
    width: 90,
    height: 40,
  });
  try {
    await act(async () => setup.renderOnce());
    const nodes = descendants(setup.renderer.root);
    const code = nodes.find((node) => node instanceof CodeRenderable);
    expect(code).toBeInstanceOf(CodeRenderable);
    if (!(code instanceof CodeRenderable))
      throw new Error("Code fence is unavailable");
    await act(async () => {
      await code.highlightingDone;
      await setup.renderOnce();
    });
    const screen = setup.captureCharFrame();
    for (const text of [
      "This is conversation text, not document metadata.",
      "A heading",
      "strong",
      "gentle",
      "Finished",
      "Waiting",
      "Quoted answer",
      "sample",
      "42",
      "*literal stars*",
      "<script>visible source</script>",
      "sample.ts",
      "const answer = 42;",
    ]) {
      expect(screen).toContain(text);
    }
    expect(screen).not.toContain("**strong**");
    expect(screen).not.toContain("```ts");
    const lines = screen.split("\n");
    const parent = lines.findIndex((line) => line.includes("Parent item"));
    expect(parent).toBeGreaterThanOrEqual(0);
    expect(lines[parent + 1]).toContain("Nested item");
    const chunks = nodes.flatMap((node) =>
      node instanceof TextRenderable ? node.chunks : [],
    );
    expect(
      chunks.some(
        (chunk) =>
          chunk.text === "strong" &&
          ((chunk.attributes ?? 0) & TextAttributes.BOLD) !== 0,
      ),
    ).toBe(true);
    expect(
      chunks.some(
        (chunk) =>
          chunk.text === "gentle" &&
          ((chunk.attributes ?? 0) & TextAttributes.ITALIC) !== 0,
      ),
    ).toBe(true);
    expect(
      chunks.some(
        (chunk) =>
          chunk.text === "a link" && chunk.link?.url === "https://example.com",
      ),
    ).toBe(true);
    expect(code.content).toBe("const answer = 42;");
    expect(
      chunks.some(
        (chunk) => chunk.link?.url === "https://example.com/diagram.png",
      ),
    ).toBe(true);
    expect(nodes.some((node) => node instanceof TextTableRenderable)).toBe(
      true,
    );
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("streaming fence completion updates its native block and leaves earlier text mounted", async () => {
  let update: ((content: string) => void) | undefined;
  const prefix =
    "Settled introduction.\n\n| Name | Value |\n| --- | --- |\n| answer | 42 |\n\n";
  function Streaming() {
    const [content, setContent] = useState(`${prefix}\`\`\`ts\nconst ans`);
    update = setContent;
    return (
      <Markdown content={content} streaming={!content.endsWith("Done.")} />
    );
  }
  const setup = await testRender(<Streaming />, { width: 60, height: 16 });
  try {
    await act(async () => setup.renderOnce());
    const before = descendants(setup.renderer.root);
    const introduction = before.find(
      (node) =>
        node instanceof TextRenderable &&
        node.plainText === "Settled introduction.",
    );
    const code = before.find((node) => node instanceof CodeRenderable);
    const table = before.find((node) => node instanceof TextTableRenderable);
    expect(introduction).toBeDefined();
    expect(code).toBeInstanceOf(CodeRenderable);
    if (
      !(code instanceof CodeRenderable) ||
      !(table instanceof TextTableRenderable) ||
      introduction === undefined ||
      update === undefined
    )
      throw new Error("Streaming Markdown is unavailable");
    const replace = update;
    const tableContent = table.content;
    await act(async () => {
      replace(`${prefix}\`\`\`ts\nconst answer = 42;\n\`\`\`\n\nDone.`);
      await setup.renderOnce();
    });
    await act(async () => {
      await code.highlightingDone;
      await setup.renderOnce();
    });
    const after = descendants(setup.renderer.root);
    expect(after).toContain(introduction);
    expect(after).toContain(code);
    expect(after).toContain(table);
    expect(table.content).toBe(tableContent);
    expect(code.content).toBe("const answer = 42;");
    expect(code.streaming).toBe(false);
    expect(setup.captureCharFrame()).toContain("Done.");
    expect(setup.captureCharFrame()).not.toContain("```ts");
    act(() => {
      replace(`${prefix.replace("| answer | 42 |", "| answer | 43 |")}Done.`);
    });
    await act(async () => {
      await setup.renderOnce();
    });
    expect(table.content).not.toBe(tableContent);
    expect(setup.captureCharFrame()).toContain("43");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const [entry, source] of [
  [
    "prose",
    "before \u001b]0;forged title\u0007safe \u001b]52;c;Y21k\u0007message\u001b[2J\u001b[H\u009b2J\u202e end",
  ],
  [
    "fence",
    "```text\nbefore \u001b]52;c;Y21k\u0007safe\u001b[2J\u202e end\n```",
  ],
  ["link", "[safe](https://example.test/&#27;]52;c;Y21k&#7;)"],
] as const) {
  test(`native Markdown ${entry} cannot emit terminal control sequences`, async () => {
    const setup = await testRender(<Markdown content={source} />, {
      width: 100,
      height: 20,
    });
    try {
      await act(async () => setup.renderOnce());
      for (const node of descendants(setup.renderer.root)) {
        if (node instanceof CodeRenderable) await node.highlightingDone;
        if (node instanceof TextRenderable) {
          for (const chunk of node.chunks) {
            expect(chunk.text).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
            expect(chunk.link?.url ?? "").not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
          }
        }
      }
      await act(async () => setup.renderOnce());
      const screen = setup.captureCharFrame();
      expect(screen).toContain("safe");
      expect(screen).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .map((span) => span.text)
          .join(""),
      ).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}

test("native extension rows cannot emit terminal control sequences", async () => {
  const { TerminalClientRows } =
    await import("../src/panes/conversation/client-rows.js");
  function Rows() {
    const presentation = useTerminalTheme("mocha");
    return (
      <TerminalClientRows
        presentation={presentation}
        rows={[
          {
            id: "row",
            title: "safe\u001b]52;c;Y21k\u0007\u202e title",
            detail: "safe\u001b[2J\u009b2J detail",
          },
        ]}
      />
    );
  }
  const setup = await testRender(<Rows />, { width: 100, height: 10 });
  try {
    await act(async () => setup.renderOnce());
    const screen = setup.captureCharFrame();
    expect(screen).toContain("safe title");
    expect(screen).toContain("safe detail");
    expect(screen).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

const gallery = "https://claude.ai/artifact/CfPhvRqs9e1VtP12LAPprT";

test("a Markdown link shows its label and full URL, and selecting the URL copies it whole", async () => {
  function Copyable() {
    return (
      <CopySurface>
        <Markdown
          content={`See [Screenshot gallery](${gallery}).\n\n[https://example.com/plain](https://example.com/plain)`}
        />
      </CopySurface>
    );
  }
  const setup = await testRender(<Copyable />, { width: 100, height: 10 });
  const copied = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(
    true,
  );
  try {
    await act(async () => setup.renderOnce());
    const screen = setup.captureCharFrame();
    expect(screen).toContain(`Screenshot gallery — ${gallery}`);
    // A link labelled with its own URL is not repeated.
    expect(screen.split("https://example.com/plain").length).toBe(2);
    const lines = screen.split("\n");
    const y = lines.findIndex((line) => line.includes(gallery));
    const x = lines[y]?.indexOf(gallery) ?? -1;
    expect(x).toBeGreaterThanOrEqual(0);
    await act(async () =>
      setup.mockMouse.drag(x, y, x + gallery.length - 1, y),
    );
    expect(copied.mock.calls.at(-1)?.[0]).toBe(gallery);
  } finally {
    copied.mockRestore();
    act(() => {
      setup.renderer.destroy();
    });
  }
});
