import type { KeyEvent } from "@opentui/core";
import { stringWidth } from "bun";
import {
  useDecision,
  type AwaitingItem,
  type DecisionIntent,
  type DecisionRowView,
  type DecisionView,
} from "@fungi.computer/parakeet/headless";
import { useEffect, useRef } from "react";

import { Field } from "./field.js";
import { fitFooterCaption } from "./footer-layout.js";
import { HintRow } from "./hint-row.js";
import { ModalDetails, ModalHeader } from "./modal.js";
import type { TuiPresentation } from "./presentation.js";
import { terminalText } from "./terminal-text.js";

/** At or below this many cells, the rows give way to the highlighted one's detail. */
const narrowWidth = 72;

/** Props for the decision that has taken over the composer. */
export type DecisionBoxProps = Readonly<{
  /** What to draw: Parakeet's decision view, the same one the web composer draws. */
  view: DecisionView;
  /** Apply what the person did. */
  dispatch: (intent: DecisionIntent) => void;
  colors: TuiPresentation["colors"];
  /** Cells the whole composer box spans. */
  width: number;
  /** Terminal rows, to cap the box at half of them. */
  rows: number;
  /** The composer surface the box replaces. */
  surface: TuiPresentation["colors"]["background"];
  /** Whether this box owns the keys. */
  active: boolean;
  /**
   * Esc can reach the terminal's global cancel binding before this box; the
   * frame calls this to give it to the decision's own rules instead.
   */
  escapeRef?: { current: (() => void) | undefined } | undefined;
}>;

function isPrintable(event: KeyEvent) {
  return (
    !event.ctrl &&
    !event.meta &&
    !event.option &&
    !event.super &&
    !event.hyper &&
    event.sequence.length === 1 &&
    event.sequence >= " " &&
    event.sequence !== "\x7f"
  );
}

/**
 * The composer while the Agent waits on the person. It draws a decision view
 * with the dialogs' own header, field and hint row, inside the composer's
 * place: no overlay, no dim, and the transcript stays scrollable above it.
 */
export function DecisionBox({
  view,
  dispatch,
  colors,
  width,
  rows,
  surface,
  active,
  escapeRef,
}: DecisionBoxProps) {
  const box = useRef<import("@opentui/core").BoxRenderable>(null);
  const inner = Math.max(1, width - 2);
  const narrow = width <= narrowWidth;
  const hasDetails = view.hints.some(
    (hint) => hint.label === "details" && hint.keys === "d",
  );
  const field = view.other;
  const typing = field?.focused === true;
  useEffect(() => {
    if (active && !typing && !view.detailsOpen) box.current?.focus();
  }, [active, typing, view.detailsOpen, view.phase]);
  useEffect(() => {
    if (escapeRef === undefined) return;
    escapeRef.current = () => {
      dispatch({ type: "escape" });
    };
    return () => {
      escapeRef.current = undefined;
    };
  });
  const keyDown = (event: KeyEvent) => {
    if (!active || event.ctrl || event.super || event.hyper) return;
    const name = event.name;
    // Alt+Up / Alt+Down belong to the queue, not to this decision's rows.
    if (event.meta && (name === "up" || name === "down")) return;
    if (name === "escape") {
      event.preventDefault();
      dispatch({ type: "escape" });
    } else if (view.detailsOpen) {
      if (name === "d") {
        event.preventDefault();
        dispatch({ type: "details" });
      }
    } else if (name === "up" || name === "down") {
      event.preventDefault();
      dispatch({ type: "move", delta: name === "up" ? -1 : 1 });
    } else if (name === "return" || name === "enter") {
      event.preventDefault();
      dispatch({ type: "enter" });
    } else if ((name === "space" || event.sequence === " ") && view.multiple) {
      event.preventDefault();
      dispatch({ type: "toggle" });
    } else if (!event.meta && !event.option && /^[1-9]$/u.test(name)) {
      event.preventDefault();
      dispatch({ type: "pick", number: Number(name) });
    } else if (name === "d" && hasDetails && !event.meta && !event.option) {
      event.preventDefault();
      dispatch({ type: "details" });
    } else if (isPrintable(event)) {
      event.preventDefault();
      dispatch({ type: "append", text: event.sequence });
    }
  };
  const otherKeyDown = (event: KeyEvent) => {
    if (event.ctrl) return;
    const name = event.name;
    if (name === "d" && (event.meta || event.option) && hasDetails) {
      event.preventDefault();
      dispatch({ type: "details" });
    } else if (event.meta && (name === "up" || name === "down")) return;
    else if (name === "escape") {
      event.preventDefault();
      dispatch({ type: "escape" });
    } else if (name === "up" || name === "down") {
      event.preventDefault();
      dispatch({ type: "move", delta: name === "up" ? -1 : 1 });
    }
  };
  const compact = rows < 30;
  const content = {
    title: view.title,
    summary: rows < 14 && field !== undefined ? undefined : view.summary,
    facts: view.facts,
    body: view.body,
    bodyLabel: view.bodyLabel,
    details: view.details,
  };
  if (view.detailsOpen)
    return (
      <box
        ref={box}
        flexDirection="column"
        backgroundColor={surface}
        paddingX={1}
        paddingY={1}
        focusable
        focused={active}
        onKeyDown={keyDown}
      >
        <ModalDetails
          content={content}
          width={inner}
          maxRows={rows - 8}
          colors={colors}
          onKeyDown={keyDown}
        />
        <HintRow hints={view.hints} width={inner} colors={colors} />
      </box>
    );
  // Half the terminal at most; the list scrolls inside what is left.
  const headerLines =
    1 +
    (content.summary === undefined ? 0 : 1) +
    view.facts.length +
    (view.body === undefined ? 0 : 3) +
    (compact ? 0 : 1);
  const budget = Math.max(
    Math.min(view.rows.length, 5),
    Math.floor(rows / 2) -
      headerLines -
      3 -
      (view.status === undefined ? 0 : 1) -
      (narrow ? 1 : 0),
  );
  // The Other row never scrolls away; the options scroll in what is left.
  const pinned = view.rows.filter((entry) => entry.kind === "other");
  const options = view.rows.filter((entry) => entry.kind === "option");
  const room = Math.max(1, budget - pinned.length);
  const highlighted = Math.max(
    0,
    options.findIndex((entry) => entry.highlighted),
  );
  const start = Math.max(
    0,
    Math.min(highlighted - Math.floor(room / 2), options.length - room),
  );
  const shown = [...options.slice(start, start + room), ...pinned];
  // Every option's label takes the longest label's cells, so descriptions
  // start in one column however the list scrolls.
  const labelCells = Math.min(
    Math.max(1, inner - 2),
    Math.max(0, ...options.map((entry) => stringWidth(entry.text))),
  );
  const row = (entry: DecisionRowView) => {
    const tone = entry.destructive ? colors.error : colors.foreground;
    const lit = entry.highlighted;
    const label = fitFooterCaption(entry.text, Math.max(1, inner - 2));
    const aligned =
      entry.kind === "option" && entry.description !== undefined && !narrow;
    return (
      <box key={entry.index} flexDirection="column">
        <box
          flexDirection="row"
          // Unlit rows show the box's own surface, not a second layer of it.
          backgroundColor={lit ? colors.selection : "transparent"}
          onMouseDown={() => {
            dispatch({ type: "pick", number: entry.index + 1 });
          }}
        >
          <text
            width={2}
            flexShrink={0}
            fg={lit ? colors.selectionForeground : colors.primary}
          >
            {lit ? "› " : "  "}
          </text>
          <text
            flexShrink={entry.kind === "other" ? 0 : 1}
            {...(aligned ? { width: labelCells } : {})}
            wrapMode="none"
            fg={lit ? colors.selectionForeground : tone}
            attributes={lit ? 1 : 0}
          >
            {label}
          </text>
          {entry.kind === "other" ? (
            // Mounted for the whole decision, so a burst of typing never
            // outruns it; it only shows and holds the keys while on this row.
            <box
              flexGrow={1}
              marginLeft={1}
              visible={lit || (field?.text ?? "") !== ""}
            >
              <Field
                placeholder={field?.placeholder}
                maxLength={field?.maxLength ?? 1}
                value={field?.text ?? ""}
                focused={active && typing}
                onInput={(value) => {
                  dispatch({ type: "type", text: value });
                }}
                onSubmit={() => {
                  dispatch({ type: "enter" });
                }}
                onKeyDown={otherKeyDown}
                colors={colors}
              />
            </box>
          ) : entry.description === undefined || narrow ? null : (
            <text
              flexShrink={1}
              marginLeft={2}
              wrapMode="none"
              fg={lit ? colors.selectionForeground : colors.foreground}
              attributes={2}
            >
              {fitFooterCaption(terminalText(entry.description), inner)}
            </text>
          )}
        </box>
        {lit && narrow && entry.description !== undefined ? (
          <text
            marginLeft={4}
            wrapMode="none"
            fg={colors.foreground}
            attributes={2}
          >
            {fitFooterCaption(terminalText(entry.description), inner - 4)}
          </text>
        ) : null}
      </box>
    );
  };
  return (
    <box
      ref={box}
      flexDirection="column"
      rowGap={compact ? 0 : 1}
      backgroundColor={surface}
      paddingX={1}
      paddingY={1}
      focusable
      focused={active && !typing}
      onKeyDown={keyDown}
    >
      <ModalHeader
        content={content}
        width={inner}
        compact={compact}
        full={field === undefined}
        marker={view.counter}
        colors={colors}
      />
      <box flexDirection="column">{shown.map(row)}</box>
      {view.status === undefined ? null : (
        <text
          wrapMode="none"
          fg={view.status.tone === "error" ? colors.error : colors.foreground}
          attributes={view.status.tone === "error" ? 0 : 2}
        >
          {fitFooterCaption(
            `${view.status.tone === "error" ? "● " : ""}${terminalText(view.status.text)}`,
            inner,
          )}
        </text>
      )}
      <HintRow hints={view.hints} width={inner} colors={colors} />
    </box>
  );
}

/** A waiting decision bound to its answer rules and drawn in the composer's place. */
export function AwaitingDecisionBox({
  item,
  position,
  total,
  onLater,
  ...box
}: Omit<DecisionBoxProps, "view" | "dispatch"> &
  Readonly<{
    item: AwaitingItem;
    position: number;
    total: number;
    /** Postpone the decision: it leaves the composer and waits in the footer. */
    onLater: () => void;
  }>) {
  const decision = useDecision(item, { position, total, later: onLater });
  if (decision.view === undefined) return null;
  return (
    <DecisionBox view={decision.view} dispatch={decision.dispatch} {...box} />
  );
}
