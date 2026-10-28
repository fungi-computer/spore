import { terminalText } from "./terminal-text.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type {
  KeyHint,
  SlashCommandController,
} from "@fungi.computer/parakeet/headless";
import {
  interactionTextLimit,
  type WhistleInteractionHost,
  type WhistlePendingPrompt,
} from "@fungi.computer/whistle/interaction";
import { Field } from "./field.js";
import { HintRow } from "./hint-row.js";
import {
  bodyIsCut,
  ModalDetails,
  ModalHeader,
  modalContentWidth,
  type ModalContent,
} from "./modal.js";
import { Picker, type TerminalChoice } from "./picker.js";
import type { DialogController } from "./dialog.js";
import type { TuiPresentation } from "./presentation.js";
import type { TerminalInputHandoff } from "./terminal-input-handoff.js";
import { useCopyAction } from "./copy-surface.js";

export type Colors = TuiPresentation["colors"];

/** The title, summary, facts and body a prompt carries. */
function contentOf(request: WhistlePendingPrompt["request"]): ModalContent {
  return {
    title: request.message,
    summary: request.summary,
    facts: request.facts,
    body: request.body,
    bodyLabel: request.bodyLabel,
    details: request.details,
  };
}

function TextPrompt({
  host,
  pending,
  colors,
  width,
  compact,
  detailsKey,
  hints,
  draft,
  onKey,
  textMaxLength,
}: Readonly<{
  host: WhistleInteractionHost;
  pending: WhistlePendingPrompt;
  colors: Colors;
  width: number;
  compact: boolean;
  detailsKey: string;
  hints: readonly KeyHint[];
  /** The typed answer, kept while Details replaces the field. */
  draft: { current: string };
  onKey: (event: KeyEvent) => void;
  textMaxLength?: number | undefined;
}>) {
  if (pending.request.type !== "text") return null;
  return (
    <box flexDirection="column" rowGap={compact ? 0 : 1}>
      <ModalHeader
        content={contentOf(pending.request)}
        width={width}
        compact={compact}
        detailsKey={detailsKey}
        colors={colors}
      />
      <Field
        placeholder={pending.request.placeholder}
        secret={pending.request.secret === true}
        maxLength={textMaxLength ?? interactionTextLimit}
        initialValue={draft.current}
        onInput={(value) => {
          draft.current = value;
        }}
        onSubmit={(value) => {
          host.answer(pending.sequence, value);
        }}
        onKeyDown={onKey}
        colors={colors}
      />
      <HintRow hints={hints} width={width} colors={colors} />
    </box>
  );
}

function PromptView({
  host,
  pending,
  colors,
  width,
  compact,
  rows,
  extraHints,
  onClose,
  onKey,
  customHints,
  hideChoiceTitle,
  initialIndex,
  onHighlight,
  textMaxLength,
}: Readonly<{
  host: WhistleInteractionHost;
  pending: WhistlePendingPrompt;
  colors: Colors;
  /** Cells the dialog content spans. */
  width: number;
  compact: boolean;
  /** Terminal rows, to cap the details view. */
  rows: number;
  /** Copy hints for a link or code the dialog offers. */
  extraHints: readonly KeyHint[];
  onClose: () => void;
  /** Dialog-wide keys (copy) the prompt does not own. */
  onKey: (event: KeyEvent) => boolean;
  customHints?: readonly KeyHint[] | undefined;
  hideChoiceTitle?: boolean | undefined;
  initialIndex?: number | undefined;
  onHighlight?: ((index: number) => void) | undefined;
  textMaxLength?: number | undefined;
}>) {
  const request = pending.request;
  const [showDetails, setShowDetails] = useState(false);
  const highlight = useRef<number | undefined>(undefined);
  const draft = useRef("");
  // Eight rows cannot hold a summary beside the choices; the title and the
  // choices never drop, the summary does.
  const content =
    rows < 10
      ? { ...contentOf(request), summary: undefined }
      : contentOf(request);
  const searchable = request.type === "choice" && request.options.length > 6;
  // While the person types (a text prompt or a filter), a bare d is a letter.
  const typing = request.type === "text" || searchable;
  const detailsKey = typing ? "Alt+D" : "d";
  const hasDetails =
    (request.details?.length ?? 0) > 0 || bodyIsCut(request.body, width);
  const cancel = () => {
    host.cancel();
    onClose();
  };
  const hints: readonly KeyHint[] = customHints ?? [
    { keys: "↑↓", label: "choose", priority: 1 },
    { keys: "Enter", label: "select", priority: 0 },
    ...(hasDetails
      ? [{ keys: detailsKey, label: "details", priority: 2 }]
      : []),
    ...extraHints,
    { keys: "Esc", label: "close", priority: 2 },
  ];
  const opensDetails = (event: KeyEvent) =>
    hasDetails &&
    event.name === "d" &&
    !event.ctrl &&
    (typing ? event.meta || event.option : !event.meta && !event.option);
  const promptKey = (event: KeyEvent) => {
    if (opensDetails(event)) {
      setShowDetails(true);
      return true;
    }
    return onKey(event);
  };
  if (showDetails)
    return (
      <box
        flexDirection="column"
        rowGap={compact ? 0 : 1}
        focusable
        focused
        onKeyDown={(event) => {
          if (event.name === "d" || event.name === "escape") {
            event.preventDefault();
            setShowDetails(false);
          } else if (event.ctrl && event.name === "c") {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <ModalDetails
          content={content}
          width={width}
          maxRows={rows - 8}
          colors={colors}
        />
        <HintRow
          hints={[
            { keys: "d", label: "back", priority: 0 },
            { keys: "Esc", label: "back", priority: 1 },
          ]}
          width={width}
          colors={colors}
        />
      </box>
    );
  if (request.type === "text")
    return (
      <TextPrompt
        host={host}
        pending={pending}
        colors={colors}
        width={width}
        compact={compact}
        detailsKey={detailsKey}
        draft={draft}
        textMaxLength={textMaxLength}
        hints={
          customHints ?? [
            { keys: "Enter", label: "submit", priority: 0 },
            ...(hasDetails
              ? [{ keys: detailsKey, label: "details", priority: 2 }]
              : []),
            ...extraHints,
            { keys: "Esc", label: "close", priority: 1 },
          ]
        }
        onKey={(event) => {
          if (promptKey(event)) {
            event.preventDefault();
            return;
          }
          if (event.name === "escape" || (event.ctrl && event.name === "c")) {
            event.preventDefault();
            cancel();
          }
        }}
      />
    );
  // A decision is answered in the composer; no dialog ever receives one.
  if (request.type === "decision") return null;
  // Harmless confirmations focus the action; destructive ones focus Keep.
  const choices: readonly TerminalChoice[] =
    request.type === "choice"
      ? request.options.map((option) => ({
          name: option.label,
          description: option.description,
          group: option.group,
          tone: option.destructive === true ? "destructive" : undefined,
        }))
      : request.destructive === true
        ? [
            { name: request.cancelLabel ?? "Cancel" },
            { name: request.confirmLabel ?? "Confirm", tone: "destructive" },
          ]
        : [
            { name: request.confirmLabel ?? "Confirm" },
            { name: request.cancelLabel ?? "Cancel" },
          ];
  const current =
    request.type === "choice" && request.current !== undefined
      ? request.options.findIndex((option) => option.value === request.current)
      : -1;
  return (
    <box flexDirection="column" rowGap={compact ? 0 : 1}>
      {hideChoiceTitle ? null : (
        <ModalHeader
          content={content}
          width={width}
          compact={compact}
          detailsKey={detailsKey}
          colors={colors}
        />
      )}
      <Picker
        // Details unmounts the Picker; remembering the highlight restores it.
        searchable={searchable}
        onKey={promptKey}
        hints={hints}
        collapsedGroups={
          request.type === "choice" && request.collapsedGroup !== undefined
            ? [request.collapsedGroup]
            : []
        }
        colors={colors}
        choices={choices}
        currentIndex={current >= 0 ? current : undefined}
        initialIndex={highlight.current ?? initialIndex}
        onHighlight={(index) => {
          highlight.current = index;
          onHighlight?.(index);
        }}
        onSelect={(index) => {
          if (request.type === "choice") {
            const option = request.options[index];
            if (option !== undefined)
              host.answer(pending.sequence, option.value);
          } else
            host.answer(
              pending.sequence,
              request.destructive === true ? index === 1 : index === 0,
            );
        }}
        onCancel={cancel}
      />
    </box>
  );
}

/** Terminal renderer for one Whistle interaction host snapshot. */
export function InteractionView({
  host,
  colors,
  onClose,
  onKey,
  hints: customHints,
  hideChoiceTitle,
  hideProgressWhilePrompt,
  initialIndex,
  onHighlight,
  textMaxLength,
}: Readonly<{
  host: WhistleInteractionHost;
  colors: Colors;
  onClose: () => void;
  onKey?: ((event: KeyEvent) => boolean) | undefined;
  hints?: readonly KeyHint[] | undefined;
  hideChoiceTitle?: boolean | undefined;
  /** The approval card has its own heading above this Whistle prompt. */
  hideProgressWhilePrompt?: boolean | undefined;
  initialIndex?: number | undefined;
  onHighlight?: ((index: number) => void) | undefined;
  textMaxLength?: number | undefined;
}>) {
  const state = useSyncExternalStore(host.subscribe, host.snapshot);
  const copy = useCopyAction();
  // A short terminal keeps the question and drops the command title.
  const dimensions = useTerminalDimensions();
  const compact = dimensions.height < 14;
  // The Dialog surface is at most 68 cells wide, less its padding.
  const dialogWidth = modalContentWidth(dimensions.width);
  const settled = state.status === "done" || state.status === "cancelled";
  const failed = state.status === "failed";
  const copyLink = state.handoff?.url ?? state.links[0]?.url;
  /** Copy keys work over any prompt; while typing, only Alt+C. */
  const copyKey = (key: KeyEvent) => {
    const typing = state.prompt?.request.type === "text";
    if (
      copyLink !== undefined &&
      copy !== undefined &&
      ((key.name === "c" && !typing) ||
        ((key.meta || key.option) && key.name === "c"))
    ) {
      copy(copyLink);
      return true;
    }
    if (
      state.handoff?.code !== undefined &&
      copy !== undefined &&
      key.name === "x" &&
      !typing
    ) {
      copy(state.handoff.code);
      return true;
    }
    return false;
  };
  /** Without a prompt the dialog itself holds the keys. */
  const statusKey = (key: KeyEvent) => {
    if (copyKey(key)) key.preventDefault();
    else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      host.cancel();
      onClose();
    } else if (settled && (key.name === "return" || key.name === "enter")) {
      key.preventDefault();
      onClose();
    }
  };
  const holdsKeys = state.prompt === undefined && !failed;
  const handoff = state.handoff;
  const message =
    failed ||
    (hideProgressWhilePrompt &&
      state.prompt !== undefined &&
      state.message?.type === "progress")
      ? undefined
      : state.message;
  const tone =
    message?.type === "success"
      ? colors.success
      : message?.type === "progress"
        ? colors.warning
        : colors.info;
  const copyHints: readonly KeyHint[] = [
    ...(copyLink === undefined
      ? []
      : [
          {
            keys: state.prompt?.request.type === "text" ? "Alt+C" : "c",
            label: "copy link",
            priority: 2,
          },
        ]),
    ...(state.handoff?.code === undefined
      ? []
      : [{ keys: "x", label: "copy code", priority: 2 }]),
  ];
  const hints: readonly KeyHint[] = failed
    ? []
    : settled
      ? [{ keys: "Enter", label: "close", priority: 0 }]
      : state.prompt === undefined
        ? [...copyHints, { keys: "Esc", label: "cancel", priority: 0 }]
        : [];
  return (
    <box
      flexDirection="column"
      rowGap={compact ? 0 : 1}
      focusable={holdsKeys}
      focused={holdsKeys}
      onKeyDown={(key) => {
        if (holdsKeys) statusKey(key);
      }}
    >
      {state.prompt !== undefined ? null : (
        <text fg={colors.foreground} attributes={1}>
          {terminalText(state.title)}
        </text>
      )}
      {handoff === undefined ? null : (
        <box flexDirection="column">
          <text fg={colors.foreground}>
            {terminalText(
              handoff.message ??
                (handoff.code === undefined
                  ? "Continue in your browser:"
                  : "Open this page and enter the code:"),
            )}
          </text>
          <text
            fg={colors.info}
            wrapMode="char"
            onMouseDown={() => copy?.(handoff.url)}
          >
            {terminalText(handoff.url)}
          </text>
          {handoff.code === undefined ? null : (
            <box flexDirection="column">
              <text fg={colors.accent} attributes={1}>
                {terminalText(handoff.code)}
              </text>
            </box>
          )}
        </box>
      )}
      {message === undefined ? null : (
        <box flexDirection="column">
          <text fg={colors.foreground}>
            <span fg={tone}>● </span>
            {terminalText(message.message)}
          </text>
          {state.links.map((link) => (
            <box key={link.url} flexDirection="column">
              {link.label === undefined ? null : (
                <text fg={colors.info}>{terminalText(link.label)}:</text>
              )}
              <text
                fg={colors.info}
                wrapMode="char"
                onMouseDown={() => copy?.(link.url)}
              >
                {terminalText(link.url)}
              </text>
            </box>
          ))}
        </box>
      )}
      {state.prompt === undefined ? null : (
        <PromptView
          key={state.prompt.sequence}
          host={host}
          pending={state.prompt}
          colors={colors}
          width={dialogWidth}
          compact={compact}
          rows={dimensions.height}
          extraHints={copyHints}
          onClose={onClose}
          onKey={(key) => copyKey(key) || (onKey?.(key) ?? false)}
          customHints={customHints}
          hideChoiceTitle={hideChoiceTitle}
          initialIndex={initialIndex}
          onHighlight={onHighlight}
          textMaxLength={textMaxLength}
        />
      )}
      {failed ? (
        <box flexDirection="column" rowGap={compact ? 0 : 1}>
          <text fg={colors.error}>● {terminalText(state.failure ?? "")}</text>
          <Picker
            colors={colors}
            choices={[
              ...(state.retryable ? [{ name: "Try again" }] : []),
              { name: "Close" },
            ]}
            onSelect={(index) => {
              if (state.retryable && index === 0) host.retry();
              else {
                host.cancel();
                onClose();
              }
            }}
            onCancel={() => {
              host.cancel();
              onClose();
            }}
          />
        </box>
      ) : null}
      {state.prompt !== undefined ? null : (
        <HintRow
          hints={customHints ?? hints}
          width={dialogWidth}
          colors={colors}
        />
      )}
    </box>
  );
}

/**
 * Draw Parakeet's open interaction in the frame's dialog. Parakeet decides
 * when a command needs the human; the terminal only shows and closes it.
 */
export function useInteractionDialog(
  input: Readonly<{
    dialog: Pick<DialogController, "show" | "dismiss" | "isOpen">;
    colors: Colors;
    slash: SlashCommandController;
    inputHandoff?: TerminalInputHandoff | undefined;
    enabled?: boolean;
  }>,
) {
  const view = useRef(input);
  view.current = input;
  const open = input.slash.interactions.open;
  const { store } = input.slash;
  useEffect(() => {
    if (open === undefined || input.enabled === false) return;
    let current = true;
    const handle = view.current.dialog.show(
      () => (
        <InteractionView
          host={open.host}
          colors={view.current.colors}
          onClose={() => {
            view.current.inputHandoff?.capture();
            store.close();
            handle.dismiss();
          }}
        />
      ),
      {
        onDismiss: () => {
          if (current) {
            view.current.inputHandoff?.capture();
            store.close();
          }
        },
      },
    );
    return () => {
      current = false;
      handle.dismiss();
    };
  }, [open, store, input.enabled]);
}
