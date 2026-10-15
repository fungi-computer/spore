import { terminalText } from "./terminal-text.js";
import {
  useMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "@fungi.computer/parakeet/headless";
import {
  StyledText,
  TextAttributes,
  TextTableRenderable,
  type RGBA,
  type TextChunk,
} from "@opentui/core";
import { extend, type ExtendedComponentProps } from "@opentui/react";
import { replaceEqualDeep } from "@tanstack/query-core";
import { createElement, memo } from "react";
import type { TuiPresentation } from "./presentation.js";

extend({ markdownTable: TextTableRenderable });

export type Appearance = Readonly<{
  presentation: TuiPresentation;
  foreground: RGBA;
  streaming: boolean;
}>;

type InlineStyle = Pick<TextChunk, "fg" | "bg" | "attributes" | "link">;

/** Translate parsed inline nodes to native styled text; no Markdown reparse. */
function inlineChunks(
  nodes: readonly MarkdownInline[],
  presentation: TuiPresentation,
  style: InlineStyle = {},
): TextChunk[] {
  const { colors, surface } = presentation;
  return nodes.flatMap((node): TextChunk[] => {
    const chunk = (text: string): TextChunk[] => [
      { ...style, __isChunk: true, text: terminalText(text) },
    ];
    switch (node.type) {
      case "text":
      case "inlineHtml":
        return chunk(node.value);
      case "inlineCode":
        return [
          {
            ...style,
            __isChunk: true,
            text: terminalText(node.value),
            fg: colors.accent,
            bg: surface,
          },
        ];
      case "break":
        return chunk("\n");
      case "strong":
      case "emphasis":
      case "strike": {
        const attribute =
          node.type === "strong"
            ? TextAttributes.BOLD
            : node.type === "emphasis"
              ? TextAttributes.ITALIC
              : TextAttributes.STRIKETHROUGH;
        return inlineChunks(node.children, presentation, {
          ...style,
          attributes: (style.attributes ?? 0) | attribute,
        });
      }
      case "link": {
        // Terminals and multiplexers may drop OSC 8, so the destination is
        // drawn as plain text that mouse selection copies whole.
        const url = terminalText(node.href);
        const linkStyle: InlineStyle = {
          ...style,
          fg: colors.info,
          attributes: (style.attributes ?? 0) | TextAttributes.UNDERLINE,
          link: { url },
        };
        const label = inlineChunks(node.children, presentation, linkStyle);
        if (label.map((part) => part.text).join("") === url) return label;
        return [
          ...label,
          { ...style, __isChunk: true, text: " — " },
          { ...linkStyle, __isChunk: true, text: url },
        ];
      }
      case "image": {
        const image: TextChunk = {
          ...style,
          __isChunk: true,
          text: terminalText(
            `[${node.alt || "Image"}]${node.src ? ` (${node.src})` : ""}`,
          ),
        };
        if (node.src) image.link = { url: terminalText(node.src) };
        return [image];
      }
      case "footnoteReference":
        return chunk(`[${String(node.number)}]`);
    }
  });
}

export function TerminalMarkdownBlocks({
  nodes,
  listItem = false,
  ...appearance
}: Appearance &
  Readonly<{ nodes: readonly MarkdownBlock[]; listItem?: boolean }>) {
  return nodes.map((node, index) => (
    <box
      key={index}
      flexShrink={0}
      marginBottom={
        index === nodes.length - 1 ||
        (listItem && nodes[index + 1]?.type === "list")
          ? 0
          : 1
      }
    >
      <Block node={node} {...appearance} />
    </box>
  ));
}

// Parsing creates new AST objects. Preserve native cells when only later prose
// changes; OpenTUI uses each cell's chunk-array identity to retain its buffers.
function TableView({
  node,
  presentation,
  foreground,
}: Pick<Appearance, "presentation" | "foreground"> &
  Readonly<{ node: Extract<MarkdownBlock, { type: "table" }> }>) {
  const { colors } = presentation;
  return createElement("markdownTable", {
    content: [
      node.header.map((cell) =>
        inlineChunks(cell.children, presentation, {
          attributes: TextAttributes.BOLD,
        }),
      ),
      ...node.rows.map((row) =>
        row.map((cell) => inlineChunks(cell.children, presentation)),
      ),
    ],
    fg: foreground,
    borderColor: colors.surface,
    columnWidthMode: "full",
    columnFitter: "balanced",
    wrapMode: "word",
    cellPaddingX: 1,
    border: true,
    selectable: true,
    selectionBg: colors.selection,
    selectionFg: colors.selectionForeground,
    flexShrink: 0,
  } satisfies ExtendedComponentProps<typeof TextTableRenderable>);
}

const Table = memo(
  TableView,
  (before, after) =>
    before.presentation.colors === after.presentation.colors &&
    before.presentation.surface === after.presentation.surface &&
    before.foreground === after.foreground &&
    replaceEqualDeep(before.node, after.node) === before.node,
);

function Block({
  node,
  ...appearance
}: Appearance & Readonly<{ node: MarkdownBlock }>) {
  const { presentation, foreground, streaming } = appearance;
  const { colors, syntax } = presentation;
  const selection = {
    selectionBg: colors.selection,
    selectionFg: colors.selectionForeground,
  };
  switch (node.type) {
    case "paragraph":
    case "heading":
      return (
        <text
          flexShrink={0}
          fg={foreground}
          {...selection}
          content={
            new StyledText(
              inlineChunks(node.children, presentation, {
                attributes:
                  node.type === "heading"
                    ? TextAttributes.BOLD
                    : TextAttributes.NONE,
              }),
            )
          }
        />
      );
    case "code":
      return (
        <box flexShrink={0}>
          {node.title ? (
            <text fg={colors.info}>{terminalText(node.title)}</text>
          ) : null}
          <code
            content={terminalText(node.value)}
            {...(node.lang ? { filetype: node.lang } : {})}
            syntaxStyle={syntax}
            fg={foreground}
            bg={colors.background}
            wrapMode="word"
            streaming={streaming}
            flexShrink={0}
            {...selection}
          />
        </box>
      );
    case "blockquote":
      return (
        <box
          border={["left"]}
          borderColor={colors.primary}
          paddingLeft={1}
          flexShrink={0}
        >
          <TerminalMarkdownBlocks nodes={node.children} {...appearance} />
        </box>
      );
    case "list":
      return (
        <box flexShrink={0}>
          {node.items.map((item, index) => (
            <box
              key={index}
              flexDirection="row"
              flexShrink={0}
              marginBottom={node.loose && index < node.items.length - 1 ? 1 : 0}
            >
              <text fg={colors.primary} flexShrink={0}>
                {item.checked === undefined
                  ? node.ordered
                    ? `${String((node.start ?? 1) + index)}. `
                    : "• "
                  : item.checked
                    ? "☑ "
                    : "☐ "}
              </text>
              <box flexGrow={1} flexShrink={1}>
                <TerminalMarkdownBlocks
                  nodes={item.children}
                  listItem
                  {...appearance}
                />
              </box>
            </box>
          ))}
        </box>
      );
    case "table":
      return (
        <Table
          node={node}
          presentation={presentation}
          foreground={foreground}
        />
      );
    case "thematicBreak":
      return (
        <box
          border={["bottom"]}
          borderColor={colors.surface}
          height={1}
          flexShrink={0}
        />
      );
    case "html":
      return (
        <text fg={foreground} {...selection}>
          {terminalText(node.value)}
        </text>
      );
    case "footnotes":
      return (
        <box flexShrink={0}>
          {node.items.map((item) => (
            <box key={item.id} flexDirection="row" flexShrink={0}>
              <text
                fg={colors.info}
                flexShrink={0}
              >{`[${String(item.number)}] `}</text>
              <box flexGrow={1} flexShrink={1}>
                <TerminalMarkdownBlocks nodes={item.children} {...appearance} />
              </box>
            </box>
          ))}
        </box>
      );
    case "callout":
      return (
        <box flexShrink={0}>
          <text fg={colors.info}>{terminalText(node.title)}</text>
          <TerminalMarkdownBlocks nodes={node.children} {...appearance} />
        </box>
      );
    case "component":
      return (
        <box flexShrink={0}>
          <TerminalMarkdownBlocks nodes={node.children} {...appearance} />
        </box>
      );
  }
}

/** Native presentation of Parakeet's shared TanStack document. */
export function TerminalMarkdown({
  content,
  ...appearance
}: Appearance & Readonly<{ content: string }>) {
  const document = useMarkdown(content);
  return (
    <box flexGrow={1} flexShrink={1}>
      <TerminalMarkdownBlocks nodes={document.children} {...appearance} />
    </box>
  );
}
