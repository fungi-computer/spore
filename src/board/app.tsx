import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { fitFooterCaption } from "../button/footer-layout.js";
import { terminalText } from "../button/terminal-text.js";
import { useTerminalTheme } from "../button/terminal-theme.js";
import type { ThemeName } from "../button/theme-preferences.js";
import { stringWidth } from "bun";
import type { BoardController } from "./controller.js";
import {
  boardView,
  type BoardRow,
  type BoardTone,
  type BoardView,
} from "./view.js";

/** How often ages are recomputed; the controller re-reads on its own cadence. */
const clockMs = 15_000;

const toneColors = {
  attention: "warning",
  error: "error",
  running: "info",
  settled: "success",
  muted: "foreground",
} as const satisfies Record<BoardTone, string>;

const hints = "↑↓ move · ↵ open · a lanes · s shipped · r refresh · q quit";

/** The vertical scrollbar's cells, taken from the rows' width when it shows. */
const scrollbarWidth = 1;

/** One drawn row of the board; every line is exactly one cell tall. */
type BoardLine = Readonly<
  { key: string } & (
    | { kind: "gap" | "heading" | "reading" }
    | { kind: "failure" | "calm" | "note" | "problem"; text: string }
    | { kind: "title"; text: string; attention: boolean }
    | { kind: "row"; row: BoardRow }
  )
>;

/**
 * The board as one-cell lines in reading order, so the program knows exactly
 * when the list overflows the terminal and how much sits below.
 */
function boardLines(view: BoardView | undefined): readonly BoardLine[] {
  const heading: BoardLine = { key: "heading", kind: "heading" };
  if (view === undefined) return [heading, { key: "reading", kind: "reading" }];
  const summaryAfter = view.sections.findLastIndex(
    (section) => section.id !== "shipped",
  );
  const summary: readonly BoardLine[] =
    view.summary === null
      ? []
      : [
          { key: "summary-gap", kind: "gap" },
          { key: "summary", kind: "note", text: view.summary },
        ];
  return [
    heading,
    ...(view.failure === null
      ? []
      : [{ key: "failure", kind: "failure", text: view.failure } as const]),
    ...(view.calm === null
      ? []
      : [{ key: "calm", kind: "calm", text: view.calm } as const]),
    ...(summaryAfter < 0 ? summary : []),
    ...view.sections.flatMap((section, index): readonly BoardLine[] => [
      { key: `${section.id}/gap`, kind: "gap" },
      {
        key: `${section.id}/title`,
        kind: "title",
        text: section.title,
        attention: section.id === "needs",
      },
      ...section.rows.map(
        (row) => ({ key: row.id, kind: "row", row }) as const,
      ),
      ...section.notes.map(
        (text, note) =>
          ({
            key: `${section.id}/note/${String(note)}`,
            kind: "note",
            text,
          }) as const,
      ),
      // Unread sources stand apart from the list they would have filled.
      ...(section.problems.length === 0
        ? []
        : [{ key: `${section.id}/problems-gap`, kind: "gap" } as const]),
      ...section.problems.map(
        (text, problem) =>
          ({
            key: `${section.id}/problem/${String(problem)}`,
            kind: "problem",
            text,
          }) as const,
      ),
      ...(index === summaryAfter ? summary : []),
    ]),
  ];
}

/**
 * The Board as a terminal program: what needs you, which Agents are stuck and
 * what shipped today. It runs in whatever terminal opens it, takes that
 * terminal's colors, and asks its host to open a conversation on Enter.
 */
export function BoardApp({
  controller,
  title,
  theme,
  open,
  quit,
}: Readonly<{
  controller: BoardController;
  /** The folder's name, for the heading. */
  title: string;
  /** The person's saved theme; `terminal` takes the terminal's own colors. */
  theme: ThemeName;
  /** Ask to open a conversation; the reply is a short line to show. */
  open: (target: {
    agentId: string;
    sessionId: string;
  }) => Promise<string | undefined>;
  quit: () => void;
}>) {
  const { width, height } = useTerminalDimensions();
  const { colors } = useTerminalTheme(theme);
  const [, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    const stop = controller.subscribe(() => {
      setTick((tick) => tick + 1);
      setNow(Date.now());
    });
    const clock = setInterval(() => {
      setNow(Date.now());
    }, clockMs);
    return () => {
      stop();
      clearInterval(clock);
    };
  }, [controller]);

  const projection = controller.read();
  const view =
    projection === undefined
      ? undefined
      : boardView(projection, {
          width,
          now: Math.max(now, projection.readAt),
        });
  const rows = view?.selectable ?? [];
  const selected =
    rows.find((row) => row.id === selectedId) ?? rows[0] ?? undefined;

  useKeyboard((key) => {
    if (
      key.name === "q" ||
      key.name === "escape" ||
      (key.ctrl && key.name === "c")
    ) {
      quit();
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const index = selected === undefined ? 0 : rows.indexOf(selected);
      const next =
        rows[
          Math.max(
            0,
            Math.min(rows.length - 1, index + (key.name === "up" ? -1 : 1)),
          )
        ];
      if (next !== undefined) setSelectedId(next.id);
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const target = selected?.open;
      if (target !== undefined) void open(target).then(setMessage);
      return;
    }
    if (key.name === "a") controller.toggle("lanes");
    else if (key.name === "s") controller.toggle("shipping");
    else if (key.name === "r") controller.refresh();
  });

  const compact = view?.compact ?? false;
  const lines = boardLines(view);
  // The scroll area sits under one row of top padding and above the footer.
  const viewport = Math.max(1, height - 2);
  const overflows = lines.length > viewport;
  const below = Math.max(0, lines.length - viewport - scrollTop);
  const inner = Math.max(10, width - 2 - (overflows ? scrollbarWidth : 0));
  const gutter = 2;
  // Rows without a conversation keep the hint's width, so every right
  // column ends on the same cell.
  const hintWidth =
    rows.length === 0 ? 0 : stringWidth(compact ? "↵" : "↵ open");
  const caption = (text: string, key: string, fg = colors.foreground) => (
    <box key={key} paddingX={1} height={1}>
      <text fg={fg} attributes={2} wrapMode="none">
        {fitFooterCaption(terminalText(text), inner)}
      </text>
    </box>
  );
  const rowLine = (row: BoardRow) => {
    const isSelected = row.id === selected?.id;
    const hint =
      row.open === undefined ? " ".repeat(hintWidth) : compact ? "↵" : "↵ open";
    const meta = hintWidth === 0 ? row.meta : `${row.meta}  ${hint}`;
    const metaWidth = stringWidth(meta);
    return (
      <box
        key={row.id}
        flexDirection="row"
        height={1}
        paddingX={1}
        backgroundColor={isSelected ? colors.selection : colors.background}
        onMouseDown={() => {
          setSelectedId(row.id);
        }}
      >
        <text width={gutter} flexShrink={0} fg={colors[toneColors[row.tone]]}>
          ●
        </text>
        <text
          flexGrow={1}
          wrapMode="none"
          fg={isSelected ? colors.selectionForeground : colors.foreground}
        >
          {fitFooterCaption(
            terminalText(row.title),
            Math.max(1, inner - gutter - metaWidth - 2),
          )}
        </text>
        <text
          flexShrink={0}
          attributes={isSelected ? 0 : 2}
          fg={isSelected ? colors.selectionForeground : colors.foreground}
        >
          {meta}
        </text>
      </box>
    );
  };
  const drawLine = (line: BoardLine) => {
    switch (line.kind) {
      case "gap":
        return <box key={line.key} height={1} />;
      case "heading":
        return (
          <box
            key={line.key}
            flexDirection="row"
            paddingX={1}
            height={1}
            justifyContent="space-between"
          >
            <text fg={colors.foreground} attributes={1} wrapMode="none">
              {fitFooterCaption(
                compact ? "Board" : `Board · ${terminalText(title)}`,
                Math.max(1, inner - 18),
              )}
            </text>
            {view === undefined ? undefined : (
              <text fg={colors.foreground} attributes={2}>
                {compact ? view.readAt : `read ${view.readAt}`}
              </text>
            )}
          </box>
        );
      case "reading":
        return caption("Reading Agents…", line.key);
      case "failure":
        return (
          <box key={line.key} paddingX={1} height={1}>
            <text fg={colors.error} wrapMode="none">
              {fitFooterCaption(terminalText(line.text), inner)}
            </text>
          </box>
        );
      case "calm":
        // The calm line keeps its double-space breath, so it is clipped
        // rather than fitted; boardView already sizes it for the width.
        return (
          <box key={line.key} paddingX={1} height={1}>
            <text fg={colors.foreground} wrapMode="none">
              {terminalText(line.text)}
            </text>
          </box>
        );
      case "title":
        return (
          <box key={line.key} paddingX={1} height={1}>
            <text
              fg={line.attention ? colors.warning : colors.foreground}
              attributes={1}
              wrapMode="none"
            >
              {fitFooterCaption(terminalText(line.text), inner)}
            </text>
          </box>
        );
      case "row":
        return rowLine(line.row);
      case "note":
        return caption(line.text, line.key);
      case "problem":
        return (
          <box key={line.key} paddingX={1} height={1}>
            <text fg={colors.error} wrapMode="none">
              {fitFooterCaption(terminalText(line.text), inner)}
            </text>
          </box>
        );
    }
  };
  const footer = message ?? (compact ? "↑↓ ↵ a s r q" : hints);
  const cue = below === 0 ? "" : `↓ ${String(below)} more`;
  return (
    <box
      flexGrow={1}
      flexDirection="column"
      paddingTop={1}
      backgroundColor={colors.background}
    >
      <scrollbox
        flexGrow={1}
        scrollX={false}
        horizontalScrollbarOptions={{ visible: false }}
        scrollbarOptions={{
          showArrows: false,
          onChange: setScrollTop,
          trackOptions: {
            foregroundColor: colors.surface,
            backgroundColor: colors.background,
          },
        }}
      >
        {lines.map(drawLine)}
      </scrollbox>
      <box
        flexDirection="row"
        paddingX={1}
        height={1}
        justifyContent="space-between"
      >
        <text fg={colors.foreground} attributes={2} wrapMode="none">
          {fitFooterCaption(
            footer,
            Math.max(1, width - 2 - (cue === "" ? 0 : stringWidth(cue) + 2)),
          )}
        </text>
        {cue === "" ? undefined : (
          <text fg={colors.foreground} attributes={2} flexShrink={0}>
            {cue}
          </text>
        )}
      </box>
    </box>
  );
}
