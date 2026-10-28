import { useTerminalDimensions } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import { stringWidth } from "bun";
import type { ReactNode } from "react";
import { fitFooterCaption } from "./footer-layout.js";
import type { TuiPresentation } from "./presentation.js";
import { terminalText } from "./terminal-text.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One labelled value in a modal's facts or details. */
export type ModalEntry = Readonly<{ label: string; value: string }>;

/** The text a Whistle prompt carries above its choices. */
export type ModalContent = Readonly<{
  title: string;
  summary?: string | undefined;
  facts?: readonly ModalEntry[] | undefined;
  body?: string | undefined;
  bodyLabel?: string | undefined;
  details?: readonly ModalEntry[] | undefined;
}>;

/** Cells a modal's content spans on a terminal `columns` wide (surface minus padding). */
export const modalContentWidth = (columns: number) =>
  Math.max(1, Math.min(68, columns - 2) - 4);

/** The most lines one fact value takes before it is cut. */
const factLines = 2;
/** The most lines of long user text before "d shows all". */
const bodyLines = 3;

/** Cut `text` to at most `width` cells without splitting a grapheme. */
function cutCells(text: string, width: number): string {
  let out = "";
  for (const { segment } of graphemes.segment(text)) {
    if (stringWidth(out + segment) > width) break;
    out += segment;
  }
  return out;
}

/** Word-wrap one paragraph into lines of at most `width` cells. */
function wrapParagraph(paragraph: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of paragraph.split(/\s+/u).filter((part) => part !== "")) {
    let rest = word;
    while (stringWidth(rest) > width) {
      if (line !== "") {
        lines.push(line);
        line = "";
      }
      const head = cutCells(rest, width);
      if (head === "") return lines;
      lines.push(head);
      rest = rest.slice(head.length);
    }
    if (line === "") line = rest;
    else if (stringWidth(`${line} ${rest}`) <= width) line = `${line} ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Wrap display text, keeping its paragraph breaks. */
function wrapCells(text: string, width: number): readonly string[] {
  const safe = Math.max(1, width);
  return terminalText(text)
    .split("\n")
    .flatMap((paragraph) => {
      const lines = wrapParagraph(paragraph, safe);
      return lines.length === 0 ? [""] : lines;
    });
}

/** At most `limit` lines; the last one ends in an ellipsis when text was cut. */
function clampLines(
  lines: readonly string[],
  limit: number,
  width: number,
  suffix = "…",
): readonly string[] {
  if (lines.length <= limit) return lines;
  const kept = lines.slice(0, limit);
  const last = kept[limit - 1] ?? "";
  kept[limit - 1] =
    `${cutCells(last, Math.max(0, width - stringWidth(suffix))).trimEnd()}${suffix}`;
  return kept;
}

/** Whether the body is longer than its collapsed three lines. */
export function bodyIsCut(body: string | undefined, width: number): boolean {
  return body !== undefined && wrapCells(body, width).length > bodyLines;
}

/**
 * Title, summary, facts and collapsed body: the top of every modal. Text is
 * measured and cut here so nothing wraps unpredictably in a dialog.
 */
export function ModalHeader({
  content,
  width,
  compact,
  detailsKey = "d",
  marker,
  full = false,
  colors,
}: Readonly<{
  content: ModalContent;
  /** Cells the dialog content spans. */
  width: number;
  /** The words are the point (a confirmation): show the summary and body whole. */
  full?: boolean | undefined;
  /** A short count such as `1 of 3`, right-aligned on the title line at every width. */
  marker?: string | undefined;
  /** Short terminals drop blank lines and the summary's second line. */
  compact: boolean;
  /** The key a cut body names for Details; Alt+D while the person types. */
  detailsKey?: string | undefined;
  colors: TuiPresentation["colors"];
}>) {
  const title = terminalText(content.title).replace(/\s+/gu, " ").trim();
  const labels = [
    ...(content.facts ?? []).map((fact) => fact.label),
    ...(content.body !== undefined && content.bodyLabel !== undefined
      ? [content.bodyLabel]
      : []),
  ];
  const labelWidth =
    labels.length === 0
      ? 0
      : Math.max(...labels.map((label) => stringWidth(label))) + 2;
  const valueWidth = Math.max(1, width - labelWidth);
  const summary =
    content.summary === undefined
      ? []
      : clampLines(
          wrapCells(content.summary, width),
          full ? Infinity : compact ? 1 : 2,
          width,
        );
  const bodyWidth = content.bodyLabel === undefined ? width : valueWidth;
  const body =
    content.body === undefined
      ? undefined
      : clampLines(
          wrapCells(content.body, bodyWidth),
          full ? Infinity : bodyLines,
          bodyWidth,
          `… ${detailsKey} shows all`,
        );
  const hasFacts = (content.facts?.length ?? 0) > 0;
  return (
    <box flexDirection="column" rowGap={compact ? 0 : 1}>
      <box flexDirection="column">
        {marker === undefined ? (
          <text fg={colors.foreground} attributes={1} wrapMode="none">
            {fitFooterCaption(title, width)}
          </text>
        ) : (
          <box flexDirection="row" justifyContent="space-between">
            <text fg={colors.foreground} attributes={1} wrapMode="none">
              {fitFooterCaption(
                title,
                Math.max(1, width - stringWidth(marker) - 2),
              )}
            </text>
            <text fg={colors.foreground} attributes={2} wrapMode="none">
              {marker}
            </text>
          </box>
        )}
        {summary.map((line, index) => (
          <text
            key={`summary-${String(index)}`}
            fg={colors.foreground}
            attributes={2}
            wrapMode="none"
          >
            {line}
          </text>
        ))}
      </box>
      {hasFacts || body !== undefined ? (
        <box flexDirection="column">
          {(content.facts ?? []).map((fact) => (
            <Entry
              key={fact.label}
              label={fact.label}
              lines={clampLines(
                wrapCells(fact.value, valueWidth),
                factLines,
                valueWidth,
              )}
              labelWidth={labelWidth}
              colors={colors}
            />
          ))}
          {body === undefined ? null : (
            <Entry
              label={content.bodyLabel ?? ""}
              lines={body}
              labelWidth={content.bodyLabel === undefined ? 0 : labelWidth}
              colors={colors}
            />
          )}
        </box>
      ) : null}
    </box>
  );
}

/**
 * A dialog's modal header with its choices below, sized to the dialog
 * surface. Panes use this; only the Button reads the terminal's size.
 */
export function ModalPrompt({
  content,
  colors,
  children,
}: Readonly<{
  content: ModalContent;
  colors: TuiPresentation["colors"];
  /** The choices, e.g. a Picker; absent for a status-only dialog. */
  children?: ReactNode;
}>) {
  const dimensions = useTerminalDimensions();
  const compact = dimensions.height < 14;
  return (
    <box flexDirection="column" rowGap={compact ? 0 : 1}>
      <ModalHeader
        content={content}
        width={modalContentWidth(dimensions.width)}
        compact={compact}
        colors={colors}
      />
      {children}
    </box>
  );
}

/** One label column and its value lines. */
function Entry({
  label,
  lines,
  labelWidth,
  colors,
}: Readonly<{
  label: string;
  lines: readonly string[];
  labelWidth: number;
  colors: TuiPresentation["colors"];
}>) {
  return (
    <box flexDirection="row">
      {labelWidth === 0 ? null : (
        <text
          width={labelWidth}
          flexShrink={0}
          fg={colors.foreground}
          attributes={2}
          wrapMode="none"
        >
          {terminalText(label)}
        </text>
      )}
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        {lines.map((line, index) => (
          <text key={index} fg={colors.foreground} wrapMode="none">
            {line}
          </text>
        ))}
      </box>
    </box>
  );
}

/**
 * Every fact, the full body and the producer's details, in a scrollbox capped
 * to the terminal. Choices are hidden while this shows.
 */
export function ModalDetails({
  content,
  width,
  maxRows,
  colors,
  onKeyDown,
}: Readonly<{
  content: ModalContent;
  width: number;
  maxRows: number;
  colors: TuiPresentation["colors"];
  /** Dialog-owned actions while the scrollbox holds keyboard focus. */
  onKeyDown?: ((event: KeyEvent) => void) | undefined;
}>) {
  // A detail replaces the fact or body it spells out in full.
  const details = content.details ?? [];
  const covered = (entry: ModalEntry) =>
    details.some((detail) => detail.label === entry.label);
  const entries: ModalEntry[] = [
    ...(content.body === undefined
      ? []
      : [{ label: content.bodyLabel ?? "Text", value: content.body }]
    ).filter((entry) => !covered(entry)),
    ...(content.facts ?? []).filter((entry) => !covered(entry)),
    ...details,
  ];
  const labelWidth =
    Math.max(0, ...entries.map((entry) => stringWidth(entry.label))) + 2;
  const valueWidth = Math.max(1, width - labelWidth);
  return (
    <box flexDirection="column" rowGap={1}>
      <text fg={colors.foreground} attributes={1}>
        Details
      </text>
      <scrollbox
        focused
        {...(onKeyDown === undefined ? {} : { onKeyDown })}
        scrollbarOptions={{ visible: false }}
        scrollX={false}
        maxHeight={Math.max(1, maxRows)}
      >
        {entries.map((entry, index) => (
          <Entry
            key={`${entry.label}-${String(index)}`}
            label={entry.label}
            lines={wrapCells(entry.value, valueWidth)}
            labelWidth={labelWidth}
            colors={colors}
          />
        ))}
      </scrollbox>
    </box>
  );
}
