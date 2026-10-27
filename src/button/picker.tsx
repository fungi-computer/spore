import { fitFooterCaption } from "./footer-layout.js";
import { terminalText } from "./terminal-text.js";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import type {
  BoxRenderable,
  KeyEvent,
  ScrollBoxRenderable,
} from "@opentui/core";
import type { TuiPresentation } from "./presentation.js";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyHint } from "@fungi.computer/parakeet/headless";
import { HintRow } from "./hint-row.js";
import {
  pickerRows,
  type TerminalChoice,
  type PickerRow,
} from "./picker-rows.js";
export type { TerminalChoice } from "./picker-rows.js";

export type PickerProps = Readonly<{
  title?: string | undefined;
  choices: readonly TerminalChoice[];
  onCancel: () => void;
  onSelect: (index: number) => void;
  currentIndex?: number | undefined;
  /** Where the highlight starts when it is not the current (●) choice. */
  initialIndex?: number | undefined;
  searchable?: boolean;
  showDescription?: boolean;
  collapsedGroups?: readonly string[] | undefined;
  collapsedLabel?: string | undefined;
  visibleLimit?: number | undefined;
  rowLimit?: number | undefined;
  descriptionWrap?: boolean;
  /** Reserve a fixed right-aligned description column for single-line rows. */
  descriptionWidth?: number;
  /** Live preview: the highlighted choice changed (not on mount). */
  onHighlight?: ((index: number) => void) | undefined;
  /** While true (e.g. saving), keys and pointer selection are ignored. */
  disabled?: boolean | undefined;
  /** A key the Picker does not own; return true to consume it. */
  onKey?: ((event: KeyEvent) => boolean) | undefined;
  /** Dialog key hints; defaults to choose · select · close. */
  hints?: readonly KeyHint[] | undefined;
  colors: TuiPresentation["colors"];
}>;

const defaultHints: readonly KeyHint[] = [
  { keys: "↑↓", label: "choose", priority: 1 },
  { keys: "Enter", label: "select", priority: 0 },
  { keys: "Esc", label: "close", priority: 2 },
];

type SelectableRow = Extract<PickerRow, { kind: "choice" | "expand" }>;
const rowKey = (row: SelectableRow) =>
  row.kind === "choice" ? `choice-${String(row.index)}` : "expand";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** fzf positions address UTF-16; styling must cover whole displayed graphemes. */
function MatchedText({
  text,
  positions,
  offset = 0,
  clipped = false,
}: Readonly<{
  text: string;
  positions: ReadonlySet<number>;
  offset?: number;
  clipped?: boolean;
}>) {
  if (positions.size === 0) return text;
  const matched = [...positions];
  return Array.from(graphemes.segment(text), ({ segment, index }) => {
    const start = index + offset;
    const bold =
      (!clipped || index + segment.length < text.length) &&
      matched.some(
        (position) => position >= start && position < start + segment.length,
      );
    return bold ? <b key={index}>{segment}</b> : segment;
  });
}

/** Native input editing with grouped, independently sized cursor and label cells. */
export function Picker({
  title: rawTitle,
  choices: rawChoices,
  onCancel,
  onSelect,
  currentIndex,
  initialIndex,
  collapsedGroups: rawCollapsedGroups,
  collapsedLabel: rawCollapsedLabel,
  visibleLimit,
  rowLimit,
  descriptionWrap = true,
  descriptionWidth,
  searchable = false,
  showDescription = true,
  onHighlight,
  onKey,
  disabled = false,
  hints = defaultHints,
  colors,
}: PickerProps) {
  const collapsedGroups = useMemo(
    () => rawCollapsedGroups?.map(terminalText) ?? [],
    [rawCollapsedGroups],
  );
  const collapsedLabel =
    rawCollapsedLabel === undefined
      ? undefined
      : terminalText(rawCollapsedLabel);
  const title = rawTitle === undefined ? undefined : terminalText(rawTitle);
  const choices = useMemo(
    () =>
      rawChoices.map((choice) => {
        const name = terminalText(choice.name).normalize();
        return {
          ...choice,
          // Match the same single-line whitespace that fitFooterCaption displays.
          name:
            descriptionWidth !== undefined || !descriptionWrap
              ? name.replace(/\s+/gu, " ")
              : name,
          description:
            choice.description === undefined
              ? undefined
              : terminalText(choice.description).normalize(),
          group:
            choice.group === undefined ? undefined : terminalText(choice.group),
        };
      }),
    [rawChoices, descriptionWidth, descriptionWrap],
  );
  const renderer = useRenderer();
  const { width, height: terminalHeight } = useTerminalDimensions();
  const compact = terminalHeight < 14;
  const scroll = useRef<ScrollBoxRenderable>(null);
  const revealPending = useRef(true);
  const focus = useRef<BoxRenderable>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(
    `choice-${String(initialIndex ?? currentIndex ?? 0)}`,
  );
  const selection = useRef(selected);
  const selectKey = (key: string) => {
    if (key === selection.current) return;
    selection.current = key;
    setSelected(key);
    const index = /^choice-(\d+)$/u.exec(key)?.[1];
    if (index !== undefined) onHighlight?.(Number(index));
  };
  const rows = useMemo(
    () =>
      pickerRows(choices, {
        query,
        collapsedGroups,
        collapsedLabel,
        visibleLimit,
        rowLimit,
        expanded,
      }),
    [
      choices,
      query,
      collapsedGroups,
      collapsedLabel,
      visibleLimit,
      rowLimit,
      expanded,
    ],
  );
  const options = rows.filter(
    (row): row is SelectableRow =>
      row.kind === "choice" || row.kind === "expand",
  );
  const selectedIndex = Math.max(
    0,
    options.findIndex((row) => rowKey(row) === selected),
  );
  const activeKey =
    options[selectedIndex] === undefined
      ? undefined
      : rowKey(options[selectedIndex]);
  const [contentWidth, setContentWidth] = useState(
    Math.max(1, Math.min(68, width - 2) - (compact ? 4 : 6) - 2),
  );
  useLayoutEffect(() => {
    if (descriptionWidth === undefined) return;
    // Read the settled native width so end truncation also follows resizes.
    const measure = () => {
      if (focus.current) setContentWidth(Math.max(1, focus.current.width - 2));
    };
    renderer.addPostProcessFn(measure);
    return () => {
      renderer.removePostProcessFn(measure);
    };
  }, [renderer, descriptionWidth]);
  const activate = (row: SelectableRow | undefined) => {
    if (disabled) return;
    if (row?.kind === "choice") onSelect(row.index);
    else if (row?.kind === "expand") {
      setExpanded(true);
      const visible = new Set(
        rows.flatMap((candidate) =>
          candidate.kind === "choice" ? [candidate.index] : [],
        ),
      );
      const index = choices.findIndex((_choice, index) => !visible.has(index));
      selectKey(`choice-${String(index)}`);
    }
  };
  const keyDown = (event: KeyEvent) => {
    if (onKey?.(event) === true) {
      event.preventDefault();
      return;
    }
    if (event.name === "escape" || (event.ctrl && event.name === "c")) {
      event.preventDefault();
      if (!disabled) onCancel();
    } else if (disabled) {
      event.preventDefault();
    } else if (
      !event.ctrl &&
      !event.meta &&
      !event.option &&
      /^[1-9]$/.test(event.name)
    ) {
      event.preventDefault();
      activate(options[Number(event.name) - 1]);
    } else if (event.name === "up" || event.name === "down") {
      event.preventDefault();
      const next =
        options[
          Math.max(
            0,
            Math.min(
              options.length - 1,
              Math.max(
                0,
                options.findIndex((row) => rowKey(row) === selection.current),
              ) + (event.name === "up" ? -1 : 1),
            ),
          )
        ];
      if (next) selectKey(rowKey(next));
    } else if (
      !searchable &&
      (event.name === "return" || event.name === "enter")
    ) {
      event.preventDefault();
      activate(
        options[
          Math.max(
            0,
            options.findIndex((row) => rowKey(row) === selection.current),
          )
        ],
      );
    }
  };
  useLayoutEffect(() => {
    if (!searchable) focus.current?.focus();
  }, [searchable]);
  useLayoutEffect(() => {
    revealPending.current = true;
    // Reveal only after native layout has sized the resized viewport and rows.
    const reveal = () => {
      if (!revealPending.current || activeKey === undefined) return;
      revealPending.current = false;
      scroll.current?.scrollChildIntoView(activeKey);
    };
    renderer.addPostProcessFn(reveal);
    return () => {
      renderer.removePostProcessFn(reveal);
    };
  }, [renderer, activeKey, rows]);
  const chrome =
    (title === undefined ? 0 : compact ? 1 : 2) +
    (searchable ? (compact ? 1 : 2) : 0) +
    (compact ? 1 : 2);
  const maxHeight = Math.max(1, terminalHeight - (compact ? 4 : 6) - chrome);
  const rowHeight = (row: PickerRow) => {
    if (!descriptionWrap) return 1;
    if (row.kind !== "choice" && row.kind !== "expand") return 1;
    const label =
      row.kind === "choice"
        ? `${row.index === currentIndex ? "● " : ""}${row.choice.name}`
        : row.label;
    const description =
      row.kind === "choice" &&
      showDescription &&
      (!compact || descriptionWidth !== undefined)
        ? row.choice.description
        : undefined;
    if (
      description &&
      Bun.stringWidth(label) + Bun.stringWidth(description) + 4 <= contentWidth
    )
      return 1;
    return (
      Math.max(
        1,
        Math.ceil(Bun.stringWidth(label) / Math.max(1, contentWidth - 2)),
      ) +
      (description
        ? Math.ceil(
            Bun.stringWidth(description) / Math.max(1, contentWidth - 2),
          )
        : 0)
    );
  };
  return (
    <box
      ref={focus}
      width="100%"
      minWidth={0}
      focusable={!searchable}
      focused={!searchable}
      onSizeChange={() => {
        if (focus.current)
          setContentWidth(Math.max(1, focus.current.width - 2));
      }}
      onKeyDown={(event) => {
        if (!searchable) keyDown(event);
      }}
      flexDirection="column"
      backgroundColor={colors.background}
    >
      {title === undefined ? null : (
        <text
          fg={colors.foreground}
          attributes={1}
          marginBottom={compact ? 0 : 1}
        >
          {title}
        </text>
      )}
      {searchable ? (
        <box flexDirection="row" marginBottom={compact ? 0 : 1}>
          <text fg={colors.accent} width={2} flexShrink={0}>
            {"/ "}
          </text>
          <input
            flexGrow={1}
            value={query}
            placeholder="type to filter"
            onInput={(value) => {
              setQuery(value);
              selectKey("");
            }}
            onSubmit={() => {
              activate(
                options[
                  Math.max(
                    0,
                    options.findIndex(
                      (row) => rowKey(row) === selection.current,
                    ),
                  )
                ],
              );
            }}
            onKeyDown={keyDown}
            focused
            backgroundColor={colors.background}
            focusedBackgroundColor={colors.background}
            textColor={colors.foreground}
            focusedTextColor={colors.foreground}
            cursorColor={colors.accent}
          />
        </box>
      ) : null}
      {/* OpenTUI numeric height updates disable shrinking; a basis stays flexible. */}
      <scrollbox
        ref={scroll}
        onSizeChange={() => {
          revealPending.current = true;
        }}
        flexBasis={Math.min(
          maxHeight,
          Math.max(
            1,
            rows.reduce((height, row) => height + rowHeight(row), 0),
          ),
        )}
        scrollbarOptions={{ visible: false }}
        minHeight={1}
        flexShrink={1}
        scrollX={false}
      >
        {rows.map((row, index) => {
          if (row.kind === "blank")
            return (
              <box key={`blank-${String(index)}`} height={1} flexShrink={0} />
            );
          if (row.kind === "heading")
            return (
              <text
                key={`heading-${String(index)}`}
                fg={colors.foreground}
                attributes={2}
              >
                {row.label}
              </text>
            );
          const key = rowKey(row);
          const ordinal =
            options.findIndex((option) => rowKey(option) === key) + 1;
          const active = key === activeKey;
          const fullLabel =
            row.kind === "choice"
              ? `${row.index === currentIndex ? "● " : ""}${row.choice.name}`
              : row.label;
          const fixedDescription = descriptionWidth !== undefined;
          const descriptionColumn = 32;
          const label = fixedDescription
            ? fitFooterCaption(
                fullLabel,
                Math.max(0, contentWidth - 4 - descriptionWidth),
              )
            : descriptionWrap
              ? fullLabel
              : fitFooterCaption(
                  fullLabel,
                  Math.max(0, Math.min(descriptionColumn, contentWidth - 2)),
                );
          const fullDescription =
            row.kind === "choice" &&
            showDescription &&
            (!compact || descriptionWidth !== undefined)
              ? row.choice.description
              : undefined;
          const labelWidth = Bun.stringWidth(label);
          const description =
            fixedDescription || descriptionWrap || fullDescription === undefined
              ? fullDescription
              : Bun.stringWidth(fullDescription) <=
                  contentWidth - descriptionColumn - 4
                ? fullDescription
                : undefined;
          const beside =
            description !== undefined &&
            (!descriptionWrap ||
              labelWidth + Bun.stringWidth(description) + 4 <= contentWidth);
          return (
            <box
              key={key}
              id={key}
              flexDirection="row"
              flexShrink={0}
              backgroundColor={active ? colors.selection : colors.background}
              onMouseDown={(event) => {
                event.preventDefault();
                selectKey(key);
                activate(row);
              }}
            >
              <text width={2} flexShrink={0} fg={colors.foreground}>
                {ordinal <= 9 ? `${String(ordinal)} ` : "  "}
              </text>
              <text width={2} flexShrink={0} fg={colors.selectionForeground}>
                {active ? "▶ " : "  "}
              </text>
              <box
                flexDirection={beside ? "row" : "column"}
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
              >
                <text
                  fg={
                    row.kind === "choice" && row.choice.tone === "destructive"
                      ? colors.error
                      : active
                        ? colors.selectionForeground
                        : colors.foreground
                  }
                  flexShrink={fixedDescription ? 1 : 0}
                  flexGrow={fixedDescription ? 1 : 0}
                  minWidth={0}
                  width={
                    fixedDescription
                      ? "auto"
                      : beside
                        ? descriptionWrap
                          ? labelWidth
                          : descriptionColumn + 2
                        : "100%"
                  }
                  wrapMode={
                    !descriptionWrap || labelWidth <= contentWidth - 2
                      ? "none"
                      : "char"
                  }
                >
                  {row.kind === "choice" ? (
                    <MatchedText
                      text={label}
                      positions={row.positions}
                      offset={row.index === currentIndex ? -2 : 0}
                      clipped={label !== fullLabel}
                    />
                  ) : (
                    label
                  )}
                </text>
                {description === undefined ? null : (
                  <box
                    flexGrow={fixedDescription ? 0 : 1}
                    flexShrink={0}
                    marginLeft={fixedDescription ? 2 : 0}
                    width={fixedDescription ? descriptionWidth : "auto"}
                    alignItems={
                      fixedDescription || descriptionWrap
                        ? "flex-end"
                        : "flex-start"
                    }
                  >
                    <text
                      fg={
                        active ? colors.selectionForeground : colors.foreground
                      }
                      attributes={active ? 0 : 2}
                      wrapMode={descriptionWrap ? "char" : "none"}
                    >
                      {row.kind === "choice" ? (
                        <MatchedText
                          text={description}
                          positions={row.positions}
                          offset={row.choice.name.length + 1}
                        />
                      ) : (
                        description
                      )}
                    </text>
                  </box>
                )}
              </box>
            </box>
          );
        })}
        {options.length === 0 ? (
          <text fg={colors.foreground} attributes={2}>
            No matches
          </text>
        ) : null}
      </scrollbox>
      <HintRow
        hints={[...hints, { keys: "1–9", label: "pick", priority: 3 }]}
        compact={width < 48 || compact}
        width={contentWidth}
        colors={colors}
        marginTop={compact ? 0 : 1}
      />
    </box>
  );
}

/** One inline row: a label column and its detail, cut by terminal cells. */
export type PickerInlineRow = Readonly<{
  key: string;
  label: string;
  detail: string;
}>;

/**
 * Picker's inline layout (slash completion): no dialog and no cursor column;
 * the owner ranks the rows and holds the selection.
 */
export function PickerInline({
  rows,
  selected,
  onChoose,
  header,
  maxRows,
  width,
  colors,
}: Readonly<{
  rows: readonly PickerInlineRow[];
  selected: number;
  onChoose: (index: number) => void;
  header?: string | undefined;
  maxRows: number;
  width: number;
  colors: TuiPresentation["colors"];
}>) {
  const first = Math.max(0, Math.min(selected - maxRows + 1, rows.length));
  const visible = rows.slice(first, first + maxRows);
  const labelWidth = Math.min(
    Math.max(0, ...rows.map((row) => Bun.stringWidth(row.label))) + 2,
    Math.max(8, Math.floor(width / 3)),
  );
  return (
    <box marginX={1} flexDirection="column" flexShrink={0}>
      {header === undefined ? null : (
        <text fg={colors.foreground} attributes={2} paddingX={1}>
          {fitFooterCaption(terminalText(header), width - 2)}
        </text>
      )}
      {visible.map((row, offset) => {
        const index = first + offset;
        const active = index === selected;
        return (
          <box
            key={row.key}
            flexDirection="row"
            height={1}
            paddingX={1}
            backgroundColor={active ? colors.selection : colors.background}
            onMouseDown={(event) => {
              event.preventDefault();
              onChoose(index);
            }}
          >
            <text
              fg={active ? colors.selectionForeground : colors.accent}
              width={labelWidth}
              flexShrink={0}
            >
              {fitFooterCaption(terminalText(row.label), labelWidth - 1)}
            </text>
            <text
              fg={active ? colors.selectionForeground : colors.foreground}
              attributes={active ? 0 : 2}
              wrapMode="none"
            >
              {fitFooterCaption(
                terminalText(row.detail),
                width - labelWidth - 2,
              )}
            </text>
          </box>
        );
      })}
    </box>
  );
}
