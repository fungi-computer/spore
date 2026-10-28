import {
  useToolSigils,
  terminalCellWidth as stringWidth,
  ToolIcon,
  iconGutterWidth,
  sigilGutterText,
  sigilGutterTotalWidth,
} from "../../button/index.js";
import { fitRunTarget, runTailWidth } from "./run-header.js";
import { terminalText, fitFooterCaption } from "../../button/index.js";
import { TerminalClientRows } from "./client-rows.js";
import { RGBA, ScrollBoxRenderable, type MouseEvent } from "@opentui/core";
import { usePaneKit, usePaneKeyboard } from "../../button/index.js";
import { useQuery } from "../../button/index.js";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ParakeetTimelineItem,
  ParakeetToolCallSection,
  ParakeetToolCallView,
  ParakeetToolGroupItem,
  ToolDisclosureState,
} from "@fungi.computer/parakeet/headless";
import {
  assistantMessageVisible,
  disclosureOpen,
  formatToolDuration,
  formatTokenCount,
  initialToolDisclosure,
  toggleAllDisclosure,
  toggleDisclosure,
  toolCallDefaultOpen,
  toolStatusTone,
  toolGroupDefaultOpen,
  visibleToolCalls,
  useComposer,
  useClientContributions,
  placeClientTimeline,
  useStatus,
  useTimeline,
} from "@fungi.computer/parakeet/headless";
import type { TuiPresentation } from "../../button/index.js";
import { toolCodeQuery } from "../../button/index.js";
import { TerminalMarkdown } from "../../button/index.js";
import { userFacingCause } from "./user-facing-cause.js";

const transcriptInitialSize = 60;
const transcriptRevealSize = 60;
const transcriptMaximumSize = 240;
const timelineRowPrefix = "tui-timeline-row:";

type TimelineRange = Readonly<{ start: number; end: number }>;
type TimelineAnchor = Readonly<{ id: string; screenY: number }>;
type PendingRangeChange = Readonly<{
  anchor: TimelineAnchor | undefined;
  movement: -1 | 0 | 1;
  previousHeight: number;
  previousTop: number;
}>;

function latestRange(length: number): TimelineRange {
  return { start: Math.max(0, length - transcriptInitialSize), end: length };
}

function clampRange(range: TimelineRange, length: number): TimelineRange {
  const end = Math.max(0, Math.min(length, range.end));
  return { start: Math.max(0, Math.min(end, range.start)), end };
}

function rangesMatch(left: TimelineRange, right: TimelineRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function rowRenderableId(id: string): string {
  return `${timelineRowPrefix}${id}`;
}

function captureTimelineAnchor(
  scroll: ScrollBoxRenderable,
): TimelineAnchor | undefined {
  const viewportTop = scroll.viewport.y;
  const viewportBottom = viewportTop + scroll.viewport.height;
  const visible = scroll
    .getChildren()
    .find(
      (child) =>
        child.id.startsWith(timelineRowPrefix) &&
        child.y + child.height > viewportTop &&
        child.y < viewportBottom,
    );
  return visible === undefined
    ? undefined
    : { id: visible.id, screenY: visible.y - viewportTop };
}

function restoreTimelineAnchor(
  scroll: ScrollBoxRenderable,
  anchor: TimelineAnchor,
): boolean {
  const row = scroll.getRenderable(anchor.id);
  if (row === undefined) return false;
  const contentY = scroll.scrollTop + row.y - scroll.viewport.y;
  scroll.scrollTo(contentY - anchor.screenY);
  return true;
}

function ScriptCode({
  content,
  width,
  presentation,
}: Readonly<{
  content: string;
  width: number;
  presentation: TuiPresentation;
}>) {
  const { colors, syntax } = presentation;
  const { data } = useQuery(toolCodeQuery(content, width));
  return (
    <code
      content={terminalText(data?.content ?? content)}
      filetype="typescript"
      fg={colors.foreground}
      syntaxStyle={syntax}
      selectionBg={colors.selection}
      selectionFg={colors.selectionForeground}
      wrapMode="word"
    />
  );
}

/** Items within a section's preview, unless everything is expanded. */
function visible<T>(
  items: readonly T[],
  preview: number,
  full: boolean,
): Readonly<{ shown: readonly T[]; hidden: number }> {
  return full || items.length <= preview
    ? { shown: items, hidden: 0 }
    : { shown: items.slice(0, preview), hidden: items.length - preview };
}

function MoreLines({
  hidden,
  presentation,
}: Readonly<{ hidden: number; presentation: TuiPresentation }>) {
  if (hidden === 0) return null;
  return (
    <text fg={presentation.colors.foreground} attributes={2}>
      … {String(hidden)} more lines · Ctrl+O shows everything
    </text>
  );
}

function diffFiletype(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (/\.(?:[cm]?ts|tsx)$/u.test(path)) return "typescript";
  if (/\.(?:[cm]?js|jsx)$/u.test(path)) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return undefined;
}

/** OpenTUI's own diff view over the headless unified patch, one per file. */
function ToolDiffView({
  section,
  presentation,
}: Readonly<{
  section: Extract<ParakeetToolCallSection, { kind: "diff" }>;
  presentation: TuiPresentation;
}>) {
  const { colors, syntax } = presentation;
  const addedBg = RGBA.clone(colors.success);
  addedBg.a = 0.14;
  const removedBg = RGBA.clone(colors.error);
  removedBg.a = 0.14;
  const named = section.files.length > 0;
  return (
    <box marginBottom={1}>
      {section.files.map((file, index) => {
        const filetype = diffFiletype(file.moveTo ?? file.path);
        const additions = file.hunks.reduce(
          (count, hunk) =>
            count + hunk.lines.filter((line) => line.kind === "add").length,
          0,
        );
        const removals = file.hunks.reduce(
          (count, hunk) =>
            count + hunk.lines.filter((line) => line.kind === "remove").length,
          0,
        );
        const changedLines = Math.max(additions, removals);
        const path = file.moveTo ?? file.path;
        const label = named
          ? (section.lines.filter((row) => row.kind === "file")[index]?.text ??
            file.path)
          : path;
        return (
          <box key={`${String(index)}:${file.path ?? ""}`}>
            {label === undefined ? null : (
              <text fg={colors.foreground} attributes={1}>
                {terminalText(label)}
                {named
                  ? null
                  : ` · ${String(changedLines)} line${changedLines === 1 ? "" : "s"} changed`}
              </text>
            )}
            {file.unified === "" ? null : (
              <diff
                diff={terminalText(file.unified)}
                view="unified"
                // The gutter carries the +/- signs. Codex patch hunks have no
                // real numbers, so their gutter numbers are drawn invisibly.
                showLineNumbers
                {...(filetype === undefined ? {} : { filetype })}
                syntaxStyle={syntax}
                fg={colors.foreground}
                addedBg={addedBg}
                removedBg={removedBg}
                contextBg={colors.background}
                addedContentBg={addedBg}
                removedContentBg={removedBg}
                contextContentBg={colors.background}
                addedSignColor={colors.success}
                removedSignColor={colors.error}
                lineNumberFg={
                  file.lineNumbers ? colors.surface : colors.background
                }
                lineNumberBg={colors.background}
                selectionBg={colors.selection}
                selectionFg={colors.selectionForeground}
                wrapMode="none"
              />
            )}
          </box>
        );
      })}
    </box>
  );
}

export function ToolSectionView({
  section,
  full,
  width,
  presentation,
}: Readonly<{
  section: ParakeetToolCallSection;
  full: boolean;
  width: number;
  presentation: TuiPresentation;
}>) {
  const { colors, syntax } = presentation;
  switch (section.kind) {
    case "diff":
      return <ToolDiffView section={section} presentation={presentation} />;
    case "excerpt": {
      const { shown, hidden } = visible(section.lines, section.preview, full);
      const gutter = String(shown.at(-1)?.number ?? 0).length;
      return (
        <box marginBottom={1}>
          <text fg={colors.foreground} wrapMode="word">
            {shown.map((line, index) => (
              <span key={String(index)}>
                {line.number === undefined ? null : (
                  <span fg={colors.surface}>
                    {String(line.number).padStart(gutter)}{" "}
                  </span>
                )}
                {terminalText(line.text)}
                {index === shown.length - 1 ? "" : "\n"}
              </span>
            ))}
          </text>
          <MoreLines hidden={hidden} presentation={presentation} />
        </box>
      );
    }
    case "matches": {
      const { shown, hidden } = visible(section.matches, section.preview, full);
      return (
        <box marginBottom={1}>
          <text fg={colors.foreground} wrapMode="word">
            {shown.map((match, index) => (
              <span key={String(index)}>
                {match.location === "" ? null : (
                  <span fg={colors.info}>{terminalText(match.location)} </span>
                )}
                {terminalText(match.text)}
                {index === shown.length - 1 ? "" : "\n"}
              </span>
            ))}
          </text>
          <MoreLines hidden={hidden} presentation={presentation} />
        </box>
      );
    }
    case "command": {
      const { shown, hidden } = visible(section.lines, section.preview, full);
      return (
        <box marginBottom={1}>
          <text fg={colors.foreground}>
            <span attributes={2}>$ </span>
            {terminalText(shown.join("\n"))}
          </text>
          <MoreLines hidden={hidden} presentation={presentation} />
        </box>
      );
    }
    case "script": {
      const { shown, hidden } = visible(section.lines, section.preview, full);
      return (
        <box marginBottom={1}>
          <ScriptCode
            content={shown.join("\n")}
            presentation={presentation}
            width={width}
          />
          <MoreLines hidden={hidden} presentation={presentation} />
        </box>
      );
    }
    case "output": {
      const { shown, hidden } = visible(section.lines, section.preview, full);
      return (
        <box marginBottom={1}>
          <text fg={colors.foreground} wrapMode="word">
            {shown.map((line, index) => (
              <span
                key={String(index)}
                fg={line.stream === "stderr" ? colors.error : colors.foreground}
              >
                {line.stream === "stderr" ? "▍" : ""}
                {terminalText(line.text)}
                {index === shown.length - 1 ? "" : "\n"}
              </span>
            ))}
          </text>
          <MoreLines hidden={hidden} presentation={presentation} />
        </box>
      );
    }
    case "text": {
      const { shown, hidden } = visible(section.lines, section.preview, full);
      return (
        <box marginBottom={1}>
          {section.label === undefined ? null : (
            <text fg={colors.foreground} attributes={2}>
              {terminalText(section.label)}
            </text>
          )}
          <code
            content={terminalText(shown.join("\n"))}
            {...(section.language === undefined
              ? {}
              : { filetype: section.language })}
            fg={colors.foreground}
            syntaxStyle={syntax}
            selectionBg={colors.selection}
            selectionFg={colors.selectionForeground}
            wrapMode="word"
          />
          <MoreLines hidden={hidden} presentation={presentation} />
        </box>
      );
    }
  }
}

function statusTone(
  status: ParakeetToolCallView["status"],
  presentation: TuiPresentation,
) {
  const { colors } = presentation;
  const tone = toolStatusTone(status);
  return tone === "neutral" ? colors.foreground : colors[tone];
}

/**
 * The one owner of a transcript row's right edge: an optional dim caption, the
 * status dot, then the disclosure caret. Every row that shows a status dot
 * uses this tail, so the dots share one column; a row without a disclosure
 * keeps the caret cell blank instead of shifting its dot.
 */
function RowStatusTail({
  caption,
  tone,
  open,
  presentation,
}: Readonly<{
  /** Right-aligned before the dot; omitted rows reserve no caption width. */
  caption?: string | undefined;
  tone: RGBA;
  /** Disclosure state; undefined when the row has nothing to expand. */
  open?: boolean | undefined;
  presentation: TuiPresentation;
}>) {
  const captionWidth = runTailWidth - 4;
  return (
    <text
      selectable={false}
      fg={presentation.colors.foreground}
      wrapMode="none"
      width={caption === undefined ? 3 : runTailWidth}
      flexShrink={0}
    >
      {caption === undefined ? null : (
        <span attributes={2}>
          {fitFooterCaption(caption, captionWidth).padStart(captionWidth)}{" "}
        </span>
      )}
      <span fg={tone}>● </span>
      <span attributes={2}>{open === undefined ? " " : open ? "▾" : "▸"}</span>
    </text>
  );
}

function durationText(milliseconds: number | undefined): string {
  return milliseconds === undefined
    ? ""
    : ` · ${formatToolDuration(milliseconds)}`;
}

function ToolCallRow({
  call,
  disclosureId,
  disclosure,
  nested,
  terminalWidth,
  inset,
  toggle,
  presentation,
}: Readonly<{
  call: ParakeetToolCallView;
  disclosureId: string;
  disclosure: ToolDisclosureState;
  nested: boolean;
  terminalWidth: number;
  inset: number;
  toggle: ToggleTool;
  presentation: TuiPresentation;
}>) {
  const { colors } = presentation;
  const sigil = useToolSigils()?.[call.kind];
  const defaultOpen = toolCallDefaultOpen(call);
  const open = disclosureOpen(disclosure, disclosureId, defaultOpen);
  const running = call.status === "running";
  const bodyWidth =
    terminalWidth - 2 * inset - (nested ? 6 : 4) - (sigilGutterTotalWidth - 2);
  return (
    <box flexShrink={0}>
      <box
        flexDirection="row"
        height={1}
        onMouseDown={(event) => {
          event.preventDefault();
          toggle(disclosureId, defaultOpen);
        }}
      >
        <text
          selectable={false}
          fg={colors.foreground}
          wrapMode="none"
          flexGrow={1}
          flexShrink={1}
          marginLeft={-1}
        >
          <ToolIcon glyph={sigil} />
          <span attributes={1}>
            {terminalText(running ? call.activeVerb : call.verb)}
          </span>{" "}
          {fitRunTarget(
            terminalText(call.label),
            Math.max(
              0,
              terminalWidth -
                2 * inset -
                runTailWidth -
                sigilGutterTotalWidth -
                3 -
                stringWidth(running ? call.activeVerb : call.verb) -
                (call.exitCode === undefined
                  ? 0
                  : stringWidth(` · exit ${String(call.exitCode)}`)),
            ),
          )}
          {call.exitCode === undefined ? null : (
            <span fg={colors.error}>{` · exit ${String(call.exitCode)}`}</span>
          )}
        </text>
        <RowStatusTail
          caption={durationText(call.durationMs).replace(/^ · /u, "")}
          tone={statusTone(call.status, presentation)}
          open={open}
          presentation={presentation}
        />
      </box>
      {open ? (
        <box marginLeft={sigilGutterTotalWidth} marginTop={1}>
          {call.error === undefined ? null : (
            <text fg={colors.error} marginBottom={1}>
              {terminalText(call.error)}
            </text>
          )}
          {call.sections.map((section, index) => (
            <ToolSectionView
              key={`${section.kind}:${String(index)}`}
              section={section}
              full={disclosure.mode === "expanded"}
              presentation={presentation}
              width={bodyWidth}
            />
          ))}
        </box>
      ) : null}
    </box>
  );
}

export function ToolGroupRow({
  group,
  disclosure,
  inset,
  terminalWidth,
  toggle,
  presentation,
}: Readonly<{
  group: ParakeetToolGroupItem;
  disclosure: ToolDisclosureState;
  inset: number;
  terminalWidth: number;
  toggle: (id: string, defaultOpen: boolean) => void;
  presentation: TuiPresentation;
}>) {
  const { colors } = presentation;
  const sigils = useToolSigils();
  const defaultOpen = toolGroupDefaultOpen(group);
  const open = disclosureOpen(disclosure, group.id, defaultOpen);
  const active = group.status === "running" ? group.active : undefined;
  const sigil = sigils?.search;
  const finished = group.status === "completed";
  const single = group.calls.length === 1 ? group.calls[0] : undefined;
  if (single !== undefined)
    return (
      <box
        id={rowRenderableId(group.id)}
        flexShrink={0}
        marginBottom={1}
        paddingX={inset}
      >
        <ToolCallRow
          call={single}
          disclosure={disclosure}
          disclosureId={single.id}
          inset={inset}
          nested={false}
          presentation={presentation}
          terminalWidth={terminalWidth}
          toggle={toggle}
        />
      </box>
    );
  const rows = (
    <box>
      {visibleToolCalls(group, open).map((call) => (
        <ToolCallRow
          key={call.id}
          call={call}
          disclosure={disclosure}
          disclosureId={call.id}
          inset={inset}
          nested
          presentation={presentation}
          terminalWidth={terminalWidth}
          toggle={toggle}
        />
      ))}
    </box>
  );
  return (
    <box
      id={rowRenderableId(group.id)}
      flexShrink={0}
      marginBottom={1}
      paddingX={inset}
    >
      <box
        flexDirection="row"
        height={1}
        onMouseDown={(event) => {
          event.preventDefault();
          toggle(group.id, defaultOpen);
        }}
      >
        <text
          selectable={false}
          fg={colors.foreground}
          wrapMode="none"
          flexGrow={1}
          flexShrink={1}
          marginLeft={-1}
        >
          <ToolIcon glyph={sigil} />
          {active === undefined ? null : (
            <span attributes={1}>{terminalText(active.activeVerb)} </span>
          )}
          {fitRunTarget(
            terminalText(
              (active === undefined ? group.summary : active.label) +
                ` · ${String(group.calls.length)} ${group.calls.length === 1 ? "call" : "calls"}` +
                (group.failedCount > 0
                  ? ` · ${String(group.failedCount)} failed`
                  : ""),
            ),
            Math.max(
              0,
              terminalWidth -
                2 * inset -
                runTailWidth -
                2 -
                sigilGutterTotalWidth -
                (active === undefined ? 0 : stringWidth(active.activeVerb) + 1),
            ),
          )}
        </text>
        <RowStatusTail
          caption={durationText(group.durationMs).replace(/^ · /u, "")}
          tone={statusTone(group.status, presentation)}
          open={open}
          presentation={presentation}
        />
      </box>
      {rows}
      {finished && group.calls.length > 3 ? (
        <text
          marginLeft={sigilGutterTotalWidth}
          height={1}
          selectable={false}
          fg={colors.foreground}
          onMouseDown={(event) => {
            event.preventDefault();
            toggle(group.id, defaultOpen);
          }}
        >
          {open ? "Show less" : `Show all ${String(group.calls.length)} calls`}
        </text>
      ) : null}
    </box>
  );
}

/**
 * Plain words for the compaction's result: the before and after context
 * size when both are known, else the generic boundary label (older
 * compactions recorded no `tokensAfter`).
 */
function compactionDividerLabel(
  tokensBefore: number,
  tokensAfter: number | null,
): string {
  return tokensAfter === null
    ? "compacted · the agent's memory starts below"
    : `compacted ${formatTokenCount(tokensBefore)} → ${formatTokenCount(tokensAfter)}`;
}

/** Center the label within one dim full-width rule, never wrapping. */
function compactionDividerRule(width: number, label: string): string {
  const padded = ` ${label} `;
  const available = Math.max(0, width - padded.length);
  const left = Math.floor(available / 2);
  const right = available - left;
  return `${"─".repeat(left)}${padded}${"─".repeat(right)}`;
}

function CompactionDividerRow({
  id,
  inset,
  terminalWidth,
  presentation,
  tokensBefore,
  tokensAfter,
}: Readonly<{
  id: string;
  inset: number;
  terminalWidth: number;
  presentation: TuiPresentation;
  tokensBefore: number;
  tokensAfter: number | null;
}>) {
  return (
    <box
      id={rowRenderableId(id)}
      flexShrink={0}
      marginTop={1}
      marginBottom={1}
      paddingX={inset}
    >
      <text fg={presentation.colors.foreground} attributes={2} wrapMode="none">
        {compactionDividerRule(
          Math.max(0, terminalWidth - 2 * inset),
          compactionDividerLabel(tokensBefore, tokensAfter),
        )}
      </text>
    </box>
  );
}

const compactionNoticeText = {
  nothing_to_compact: "nothing to compact",
  failed: "compaction failed",
  stale: "compaction skipped: the context moved on",
  insufficient: "compaction skipped: the summary would not fit",
} as const;

function CompactionNoticeRow({
  id,
  inset,
  presentation,
  result,
  diagnostic,
}: Readonly<{
  id: string;
  inset: number;
  presentation: TuiPresentation;
  result: "nothing_to_compact" | "failed" | "stale" | "insufficient";
  diagnostic: string | null;
}>) {
  const { colors, dimForeground } = presentation;
  const text =
    diagnostic === null
      ? compactionNoticeText[result]
      : `${compactionNoticeText[result]}: ${userFacingCause(diagnostic)}`;
  return (
    <box
      id={rowRenderableId(id)}
      flexShrink={0}
      paddingX={inset}
      height={1}
      marginBottom={1}
    >
      <text
        fg={result === "failed" ? colors.error : dimForeground}
        attributes={2}
        wrapMode="none"
      >
        {terminalText(`· ${text}`)}
      </text>
    </box>
  );
}

type UserMessageItem = Extract<ParakeetTimelineItem, { kind: "user_message" }>;

/** A message another Agent sent in: a compact block, not a user surface. */
function isAgentMessage(item: UserMessageItem): boolean {
  return item.author?.kind === "agent";
}

/** A human line on the raised user surface; another Agent's message is not one. */
function userBlock(item: ParakeetTimelineItem): boolean {
  return item.kind === "user_message" && !isAgentMessage(item);
}

/**
 * Consecutive user blocks share one continuous surface: only their padding
 * rows separate the texts. Anything else between them keeps the ground row.
 */
function stacksOnNext(
  item: ParakeetTimelineItem,
  next: ParakeetTimelineItem | undefined,
  hasClientRowsAfter: boolean,
): boolean {
  return (
    next !== undefined &&
    !hasClientRowsAfter &&
    userBlock(item) &&
    userBlock(next)
  );
}

/** Pending delivery is presentation-only; confirmed history keeps its theme. */
function userMessageAppearance(
  item: UserMessageItem,
  presentation: TuiPresentation,
) {
  const pending = item.status === "pending" || item.status === "queued";
  const cue = pending && item.delivery === "followUp";
  return {
    cue,
    foreground: pending
      ? cue
        ? presentation.dimForeground
        : presentation.colors.accent
      : presentation.colors.foreground,
  };
}

function TimelineRowView({
  item,
  disclosure,
  inset,
  terminalWidth,
  toggle,
  presentation,
  stacksOnNext,
}: Readonly<{
  item: ParakeetTimelineItem;
  disclosure: ToolDisclosureState;
  inset: number;
  terminalWidth: number;
  toggle: ToggleTool;
  presentation: TuiPresentation;
  /** The next row is a user block too; share one continuous surface. */
  stacksOnNext: boolean;
}>) {
  const { colors, surface } = presentation;
  const errorSigil = useToolSigils()?.error;
  const agentSigil = useToolSigils()?.agent;
  if (item.kind === "compaction_divider")
    return (
      <CompactionDividerRow
        id={item.id}
        inset={inset}
        terminalWidth={terminalWidth}
        presentation={presentation}
        tokensBefore={item.tokensBefore}
        tokensAfter={item.tokensAfter}
      />
    );
  if (item.kind === "compaction_notice")
    return (
      <CompactionNoticeRow
        id={item.id}
        inset={inset}
        presentation={presentation}
        result={item.result}
        diagnostic={item.diagnostic}
      />
    );
  if (item.kind === "tool_group")
    return (
      <ToolGroupRow
        presentation={presentation}
        group={item}
        disclosure={disclosure}
        inset={inset}
        terminalWidth={terminalWidth}
        toggle={toggle}
      />
    );
  if (item.kind === "user_message" && isAgentMessage(item)) {
    const { foreground } = userMessageAppearance(item, presentation);
    // Collapsed by default; the tool rows' own disclosure state and toggle.
    const open = disclosureOpen(disclosure, item.id, false);
    const author = item.author?.name ?? "";
    const headerWidth = Math.max(
      0,
      terminalWidth - 2 * inset - sigilGutterTotalWidth,
    );
    return (
      <box
        id={rowRenderableId(item.id)}
        flexShrink={0}
        marginBottom={1}
        paddingX={inset}
      >
        <box
          flexDirection="row"
          height={1}
          onMouseDown={(event) => {
            event.preventDefault();
            toggle(item.id, false);
          }}
        >
          <text
            selectable={false}
            fg={colors.foreground}
            wrapMode="none"
            flexGrow={1}
            flexShrink={1}
            marginLeft={-1}
          >
            <ToolIcon glyph={agentSigil} />
            <span fg={presentation.dimForeground} attributes={2}>
              {fitFooterCaption(
                terminalText(open ? author : `${author} · ${item.text}`),
                headerWidth,
              )}
            </span>
          </text>
        </box>
        {open ? (
          <text
            marginLeft={sigilGutterTotalWidth}
            fg={foreground}
            attributes={item.status === "confirmed" ? 0 : 2}
            selectionBg={colors.selection}
            selectionFg={colors.selectionForeground}
          >
            {terminalText(item.text)}
          </text>
        ) : null}
      </box>
    );
  }
  if (item.kind === "user_message") {
    const { cue, foreground } = userMessageAppearance(item, presentation);
    return (
      <box
        id={rowRenderableId(item.id)}
        flexDirection="row"
        flexShrink={0}
        marginBottom={stacksOnNext ? 0 : 1}
        backgroundColor={surface}
        paddingX={inset}
        paddingY={1}
      >
        <text
          marginLeft={sigilGutterTotalWidth}
          flexGrow={1}
          flexShrink={1}
          fg={foreground}
          attributes={item.status === "confirmed" ? 1 : 2}
          {...(cue ? { wrapMode: "none" as const } : {})}
          selectionBg={colors.selection}
          selectionFg={colors.selectionForeground}
        >
          {cue
            ? fitFooterCaption(
                terminalText(item.text),
                Math.max(0, terminalWidth - 2 * inset - sigilGutterTotalWidth),
              )
            : terminalText(item.text)}
        </text>
      </box>
    );
  }
  if (!assistantMessageVisible(item)) return null;
  const text =
    item.repeatCount === undefined
      ? item.text
      : `${item.text} x${String(item.repeatCount)}`;
  return (
    <box
      id={rowRenderableId(item.id)}
      flexShrink={0}
      marginBottom={1}
      paddingX={inset}
    >
      {item.thinking ? (
        <box
          marginLeft={sigilGutterTotalWidth}
          marginBottom={item.text ? 1 : 0}
        >
          <text fg={colors.foreground} attributes={2}>
            {disclosureOpen(disclosure, item.id, false)
              ? terminalText(item.thinking)
              : "Thinking"}
          </text>
        </box>
      ) : null}
      {item.text ? (
        <box flexDirection="row">
          {item.isError ? (
            // Same net footprint as the plain-dot branch (width + the
            // reclaimed column together still equal sigilGutterTotalWidth),
            // so the markdown content beside it keeps the same position;
            // only the icon's own three columns start one cell earlier,
            // into this row's share of the pane's left inset.
            <text
              width={iconGutterWidth}
              marginLeft={-1}
              flexShrink={0}
              selectable={false}
              wrapMode="none"
            >
              <ToolIcon glyph={errorSigil} />
            </text>
          ) : (
            <text
              width={sigilGutterTotalWidth}
              flexShrink={0}
              fg={colors.info}
              wrapMode="none"
            >
              {sigilGutterText(item.pending ? "●" : "")}
            </text>
          )}
          <box flexGrow={1} flexShrink={1}>
            {item.isError && item.providerError !== undefined ? (
              <text fg={colors.error} wrapMode="word">
                {terminalText(text)}
              </text>
            ) : (
              <TerminalMarkdown
                content={text}
                presentation={presentation}
                foreground={item.isError ? colors.error : colors.foreground}
                streaming={item.pending}
              />
            )}
          </box>
          {item.isError && item.providerError === undefined ? (
            <RowStatusTail tone={colors.error} presentation={presentation} />
          ) : null}
        </box>
      ) : null}
      {item.isError && item.errorDetail ? (
        <box marginLeft={sigilGutterTotalWidth}>
          <text fg={colors.foreground} attributes={2}>
            {terminalText(item.errorDetail)}
          </text>
        </box>
      ) : null}
      {item.isError &&
      item.providerError !== undefined &&
      disclosureOpen(disclosure, item.id, false) ? (
        <box marginLeft={sigilGutterTotalWidth} flexDirection="column">
          <text fg={colors.error}>Provider details (latest response)</text>
          <text fg={colors.error}>{terminalText(item.providerError)}</text>
        </box>
      ) : null}
    </box>
  );
}

const TimelineRow = memo(TimelineRowView);

/** What the empty conversation tells the user before the first send. */
export type EmptyConversationState = Readonly<{
  /** Provider and model, or undefined when no model is selected. */
  model: string | undefined;
  /** Project folder the Session works in, when the host names it. */
  folder: string | undefined;
  /** No model provider is signed in. */
  signInRequired: boolean;
}>;

type TerminalTranscriptProps = Readonly<{
  emptyState: EmptyConversationState;
  detailsRequest: number;
  /** Increments to toggle the focused tool group (Ctrl+G). */
  groupRequest: number;
  inputEnabled: boolean;
  presentation: TuiPresentation;
  sessionAddress: string;
  terminalWidth: number;
}>;

type ToggleTool = (id: string, defaultOpen: boolean) => void;

/** The newest tool group or Agent message in the viewport: the Ctrl+G target. */
function focusedToggleRowId(
  scroll: ScrollBoxRenderable,
  toggleable: ReadonlySet<string>,
): string | undefined {
  const viewportTop = scroll.viewport.y;
  const viewportBottom = viewportTop + scroll.viewport.height;
  const visible = scroll
    .getChildren()
    .filter(
      (child) =>
        child.id.startsWith(timelineRowPrefix) &&
        toggleable.has(child.id.slice(timelineRowPrefix.length)) &&
        child.y + child.height > viewportTop &&
        child.y < viewportBottom,
    )
    .at(-1);
  return visible?.id.slice(timelineRowPrefix.length);
}

function rangeAfterReveal(
  current: TimelineRange,
  length: number,
  direction: "older" | "newer",
): TimelineRange {
  if (direction === "older") {
    const start = Math.max(0, current.start - transcriptRevealSize);
    const end = Math.min(current.end, start + transcriptMaximumSize);
    return { start, end };
  }
  const end = Math.min(length, current.end + transcriptRevealSize);
  const start = Math.max(current.start, end - transcriptMaximumSize);
  return { start, end };
}

/** Own the terminal-only scroll window and render one continuous transcript. */
function TerminalTranscriptView({
  emptyState,
  detailsRequest,
  groupRequest,
  inputEnabled,
  presentation,
  sessionAddress,
  terminalWidth,
}: TerminalTranscriptProps) {
  const timeline = useTimeline();
  const composer = useComposer();
  const sessionStatus = useStatus();
  const contributions = useClientContributions();
  const placed = useMemo(
    () =>
      placeClientTimeline(
        contributions,
        timeline.commandAnchors,
        timeline.positionAnchors,
      ),
    [contributions, timeline.commandAnchors, timeline.positionAnchors],
  );
  const { rendering } = usePaneKit();
  const inset = 1;
  const scroll = useRef<ScrollBoxRenderable>(null);
  const [range, setRange] = useState<TimelineRange>(() =>
    latestRange(timeline.settled.length),
  );
  const followingLatest = useRef(true);
  const visibleRange = followingLatest.current
    ? latestRange(timeline.settled.length)
    : clampRange(range, timeline.settled.length);
  const rangeRef = useRef(visibleRange);
  rangeRef.current = visibleRange;
  const lengthRef = useRef(timeline.settled.length);
  lengthRef.current = timeline.settled.length;
  const [readerAway, setReaderAway] = useState(false);
  const readerAwayRef = useRef(false);
  const readerAnchor = useRef<TimelineAnchor | undefined>(undefined);
  const pendingRange = useRef<PendingRangeChange | undefined>(undefined);
  const pendingHistoryReveal = useRef<
    | Readonly<{
        direction: "older" | "newer";
        change: PendingRangeChange;
      }>
    | undefined
  >(undefined);
  const restoringScroll = useRef(false);
  // View-only disclosure; never written to the Session.
  const [disclosure, setDisclosure] = useState<ToolDisclosureState>(
    initialToolDisclosure,
  );
  const detailsRequestRef = useRef(detailsRequest);
  detailsRequestRef.current = detailsRequest;
  const priorDetailsRequest = useRef(detailsRequest);
  const groupRequestRef = useRef(groupRequest);
  groupRequestRef.current = groupRequest;
  const priorGroupRequest = useRef(groupRequest);

  const updateReaderAway = useCallback((away: boolean) => {
    if (readerAwayRef.current === away) return;
    readerAwayRef.current = away;
    setReaderAway(away);
  }, []);

  const captureReader = useCallback(() => {
    const viewport = scroll.current;
    if (viewport !== null)
      readerAnchor.current = captureTimelineAnchor(viewport);
  }, []);

  const observeReader = useCallback(() => {
    if (restoringScroll.current || pendingHistoryReveal.current !== undefined)
      return;
    const viewport = scroll.current;
    if (viewport === null) return;
    const atBottom =
      viewport.scrollTop >=
      Math.max(0, viewport.scrollHeight - viewport.viewport.height - 1);
    const atLatest = rangeRef.current.end === lengthRef.current;
    if (atBottom && atLatest) {
      followingLatest.current = true;
      readerAnchor.current = undefined;
      updateReaderAway(false);
      const latest = latestRange(lengthRef.current);
      if (!rangesMatch(rangeRef.current, latest)) setRange(latest);
      return;
    }
    // A growing transcript briefly moves the sticky viewport away from the new
    // bottom before OpenTUI applies layout. Only an explicit reader movement
    // may leave follow mode.
    if (followingLatest.current) return;
    followingLatest.current = false;
    updateReaderAway(true);
    captureReader();
  }, [captureReader, updateReaderAway]);

  const requestReveal = useCallback(
    (direction: "older" | "newer", movement: -1 | 0 | 1) => {
      const viewport = scroll.current;
      if (viewport === null || pendingRange.current !== undefined) return false;
      const current = rangeRef.current;
      const change: PendingRangeChange = {
        anchor: captureTimelineAnchor(viewport),
        movement,
        previousHeight: viewport.scrollHeight,
        previousTop: viewport.scrollTop,
      };
      if (direction === "older" && current.start === 0) {
        if (!timeline.hasMoreHistory || timeline.loadingOlderHistory)
          return false;
        pendingHistoryReveal.current = { direction, change };
        timeline.loadOlderHistory();
        return true;
      }
      if (direction === "newer" && current.end === lengthRef.current) {
        if (!timeline.hasNewerHistory || timeline.loadingOlderHistory)
          return false;
        pendingHistoryReveal.current = { direction, change };
        timeline.loadNewerHistory();
        return true;
      }
      const next = rangeAfterReveal(current, lengthRef.current, direction);
      if (rangesMatch(current, next)) return false;
      pendingRange.current = change;
      followingLatest.current = false;
      updateReaderAway(true);
      setRange(next);
      return true;
    },
    [timeline, updateReaderAway],
  );

  useEffect(() => {
    const latest = latestRange(lengthRef.current);
    followingLatest.current = true;
    readerAnchor.current = undefined;
    pendingRange.current = undefined;
    pendingHistoryReveal.current = undefined;
    updateReaderAway(false);
    setRange(latest);
    priorDetailsRequest.current = detailsRequestRef.current;
    priorGroupRequest.current = groupRequestRef.current;
  }, [sessionAddress, updateReaderAway]);

  useEffect(() => {
    if (followingLatest.current) {
      setRange(latestRange(timeline.settled.length));
      return;
    }
    const historyReveal = pendingHistoryReveal.current;
    if (historyReveal !== undefined) {
      if (timeline.loadingOlderHistory) return;
      pendingHistoryReveal.current = undefined;
      pendingRange.current = historyReveal.change;
      setRange(
        historyReveal.direction === "older"
          ? {
              start: 0,
              end: Math.min(transcriptInitialSize, timeline.settled.length),
            }
          : latestRange(timeline.settled.length),
      );
      return;
    }
    setRange((current) => clampRange(current, timeline.settled.length));
  }, [timeline.loadingOlderHistory, timeline.settled]);

  useEffect(() => {
    if (priorDetailsRequest.current === detailsRequest) return;
    priorDetailsRequest.current = detailsRequest;
    captureReader();
    setDisclosure(toggleAllDisclosure);
  }, [captureReader, detailsRequest]);

  useLayoutEffect(() => {
    let remainingFrames = 2;
    let stopFrame: (() => void) | undefined;
    const afterFrame = () => {
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        stopFrame = rendering.afterFrame(afterFrame);
        rendering.requestFrame();
        return;
      }
      const viewport = scroll.current;
      if (viewport === null) return;
      restoringScroll.current = true;
      const pending = pendingRange.current;
      if (pending !== undefined) {
        pendingRange.current = undefined;
        const restored =
          pending.anchor !== undefined &&
          restoreTimelineAnchor(viewport, pending.anchor);
        if (!restored)
          viewport.scrollTo(
            pending.previousTop +
              viewport.scrollHeight -
              pending.previousHeight,
          );
        if (pending.movement !== 0)
          viewport.scrollBy(pending.movement, "viewport");
        readerAnchor.current = captureTimelineAnchor(viewport);
      } else if (followingLatest.current) {
        viewport.scrollTo(viewport.scrollHeight);
      } else if (readerAnchor.current !== undefined) {
        restoreTimelineAnchor(viewport, readerAnchor.current);
      }
      restoringScroll.current = false;
      observeReader();
    };
    stopFrame = rendering.afterFrame(afterFrame);
    rendering.requestFrame();
    return () => {
      stopFrame?.();
    };
  }, [
    disclosure,
    observeReader,
    presentation,
    rendering,
    sessionAddress,
    timeline.settled,
    timeline.tail,
    timeline.loadingOlderHistory,
    visibleRange.end,
    visibleRange.start,
    terminalWidth,
  ]);

  const toggleTool = useCallback<ToggleTool>(
    (id, defaultOpen) => {
      captureReader();
      setDisclosure((current) => toggleDisclosure(current, id, defaultOpen));
    },
    [captureReader],
  );

  useEffect(() => {
    if (priorGroupRequest.current === groupRequest) return;
    priorGroupRequest.current = groupRequest;
    const viewport = scroll.current;
    const toggleable = new Set(
      timeline.settled
        .filter(
          (item) =>
            item.kind === "tool_group" ||
            (item.kind === "user_message" && isAgentMessage(item)),
        )
        .map((item) => item.id),
    );
    const id =
      viewport === null ? undefined : focusedToggleRowId(viewport, toggleable);
    const target = timeline.settled.find((item) => item.id === id);
    if (target?.kind === "user_message") toggleTool(target.id, false);
    if (target?.kind === "tool_group") {
      const single = target.calls.length === 1 ? target.calls[0] : undefined;
      toggleTool(
        single?.id ?? target.id,
        single === undefined
          ? toolGroupDefaultOpen(target)
          : toolCallDefaultOpen(single),
      );
    }
  }, [groupRequest, timeline.settled, toggleTool]);

  usePaneKeyboard((key) => {
    if (!inputEnabled || (key.name !== "pageup" && key.name !== "pagedown"))
      return false;
    const viewport = scroll.current;
    if (viewport === null) return false;
    const pageUp = key.name === "pageup";
    if (pageUp) {
      timeline.pinVisibleHistory();
      followingLatest.current = false;
      updateReaderAway(true);
    }
    const atEdge = pageUp
      ? viewport.scrollTop <= viewport.viewport.height
      : viewport.scrollTop >=
        viewport.scrollHeight - 2 * viewport.viewport.height;
    if (!(atEdge && requestReveal(pageUp ? "older" : "newer", pageUp ? -1 : 1)))
      viewport.scrollBy(pageUp ? -1 : 1, "viewport");
    observeReader();
    key.preventDefault();
    return true;
  });

  const onMouseScroll = useCallback(
    (event: MouseEvent) => {
      const viewport = scroll.current;
      const direction = event.scroll?.direction;
      if (viewport === null || (direction !== "up" && direction !== "down"))
        return;
      if (direction === "up") {
        timeline.pinVisibleHistory();
        followingLatest.current = false;
        updateReaderAway(true);
      }
      const nearEdge =
        direction === "up"
          ? viewport.scrollTop <= viewport.viewport.height
          : viewport.scrollTop >=
            viewport.scrollHeight - 2 * viewport.viewport.height;
      if (nearEdge) requestReveal(direction === "up" ? "older" : "newer", 0);
      observeReader();
    },
    [observeReader, requestReveal, timeline, updateReaderAway],
  );

  const onMouseDown = useCallback(
    (event: MouseEvent) => {
      const viewport = scroll.current;
      if (viewport === null || event.x < viewport.x + viewport.width - 2)
        return;
      timeline.pinVisibleHistory();
      followingLatest.current = false;
      updateReaderAway(true);
    },
    [timeline, updateReaderAway],
  );

  const jumpToLatest = useCallback(() => {
    const viewport = scroll.current;
    timeline.jumpToLatest();
    pendingHistoryReveal.current = undefined;
    followingLatest.current = true;
    readerAnchor.current = undefined;
    updateReaderAway(false);
    setRange(latestRange(lengthRef.current));
    viewport?.scrollTo(viewport.scrollHeight);
  }, [timeline, updateReaderAway]);

  const visibleSettled = useMemo(
    () => timeline.settled.slice(visibleRange.start, visibleRange.end),
    [timeline.settled, visibleRange.end, visibleRange.start],
  );
  const visibleItems = useMemo(
    () =>
      visibleRange.end === timeline.settled.length
        ? [...visibleSettled, ...timeline.tail]
        : visibleSettled,
    [timeline.settled.length, timeline.tail, visibleRange.end, visibleSettled],
  );
  const rows = useMemo(
    () =>
      visibleItems.map((item, index) => (
        <Fragment key={item.id}>
          <TimelineRow
            stacksOnNext={stacksOnNext(
              item,
              visibleItems[index + 1],
              (placed.after.get(item.id)?.length ?? 0) > 0,
            )}
            presentation={presentation}
            key={item.id}
            item={item}
            disclosure={disclosure}
            inset={inset}
            terminalWidth={terminalWidth}
            toggle={toggleTool}
          />
          {placed.after.get(item.id)?.map(({ entryId, cell }) => (
            <TerminalClientRows
              key={JSON.stringify([entryId, cell.id])}
              id={rowRenderableId(JSON.stringify([entryId, cell.id]))}
              rows={cell.rows}
              presentation={presentation}
            />
          ))}
        </Fragment>
      )),
    [disclosure, presentation, terminalWidth, toggleTool, visibleItems, placed],
  );

  return (
    <box flexGrow={1} flexShrink={1} minHeight={0} paddingTop={1}>
      <scrollbox
        ref={scroll}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        stickyScroll
        stickyStart="bottom"
        scrollX={false}
        onMouseDown={onMouseDown}
        onMouseScroll={onMouseScroll}
        contentOptions={{ minHeight: 0 }}
        scrollbarOptions={{
          showArrows: false,
          onChange: observeReader,
          trackOptions: {
            foregroundColor: presentation.colors.surface,
            backgroundColor: presentation.colors.background,
          },
        }}
      >
        {sessionStatus.observation.status === "unavailable" ? (
          <text fg={presentation.colors.error} marginX={inset}>
            {sigilGutterText("●")}
            {terminalText(sessionStatus.observation.reason)} · /reconnect to
            retry
          </text>
        ) : null}
        {visibleRange.start === 0
          ? placed.before.map(({ entryId, cell }) => (
              <TerminalClientRows
                key={JSON.stringify([entryId, cell.id])}
                id={rowRenderableId(JSON.stringify([entryId, cell.id]))}
                rows={cell.rows}
                presentation={presentation}
              />
            ))
          : null}
        {visibleItems.length === 0 &&
        placed.before.length === 0 &&
        !timeline.hasMoreHistory ? (
          <box flexDirection="column" marginX={inset}>
            <text fg={presentation.colors.foreground} attributes={2}>
              Start a conversation.
            </text>
            <text fg={presentation.colors.foreground} attributes={2}>
              {terminalText(
                `Model: ${emptyState.model ?? "No model selected"}`,
              )}
            </text>
            {emptyState.folder === undefined ? null : (
              <text fg={presentation.colors.foreground} attributes={2}>
                {terminalText(`Folder: ${emptyState.folder}`)}
              </text>
            )}
            {emptyState.signInRequired ? (
              <text fg={presentation.colors.info}>
                Sign in to start: type /login
              </text>
            ) : null}
          </box>
        ) : (
          <>{rows}</>
        )}
      </scrollbox>
      {sessionStatus.viewState.kind === "error" ? (
        <box flexDirection="column" height={2} paddingX={inset}>
          <text fg={presentation.colors.error} height={1} wrapMode="none">
            {terminalText(
              `Stopped: ${userFacingCause(sessionStatus.viewState.cause)}`,
            )}
          </text>
          <text fg={presentation.colors.info} height={1} wrapMode="none">
            {composer.failure === "admission"
              ? "/retry · or edit and submit the draft"
              : "/retry · /continue · or type a new instruction"}
          </text>
        </box>
      ) : null}
      {readerAway ? (
        <text
          flexShrink={0}
          height={1}
          wrapMode="none"
          bg={presentation.colors.background}
          fg={presentation.colors.info}
          marginX={inset}
          onMouseDown={(event) => {
            event.preventDefault();
            jumpToLatest();
          }}
        >
          Jump to latest ↓
        </text>
      ) : null}
    </box>
  );
}

export const TerminalTranscript = memo(TerminalTranscriptView);
