import { terminalText } from "./terminal-text.js";
import { useEffect, useRef, useSyncExternalStore } from "react";
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
import { Picker } from "./picker.js";
import type { DialogController } from "./dialog.js";
import type { TuiPresentation } from "./presentation.js";
import type { TerminalInputHandoff } from "./terminal-input-handoff.js";
import { useCopyAction } from "./copy-surface.js";

export type Colors = TuiPresentation["colors"];

function TextPrompt({
  host,
  pending,
  colors,
  onKey,
}: Readonly<{
  host: WhistleInteractionHost;
  pending: WhistlePendingPrompt;
  colors: Colors;
  onKey: (event: KeyEvent) => void;
}>) {
  if (pending.request.type !== "text") return null;
  return (
    <box flexDirection="column">
      <text fg={colors.foreground}>
        {terminalText(pending.request.message)}
      </text>
      <Field
        placeholder={pending.request.placeholder}
        secret={pending.request.secret === true}
        maxLength={interactionTextLimit}
        onSubmit={(value) => {
          host.answer(pending.sequence, value);
        }}
        onKeyDown={onKey}
        colors={colors}
      />
    </box>
  );
}

function PromptView({
  host,
  pending,
  colors,
  onClose,
  onKey,
}: Readonly<{
  host: WhistleInteractionHost;
  pending: WhistlePendingPrompt;
  colors: Colors;
  onClose: () => void;
  /** Dialog-wide keys (copy) the prompt does not own. */
  onKey: (event: KeyEvent) => boolean;
}>) {
  const request = pending.request;
  if (request.type === "choice")
    return (
      <Picker
        title={request.message}
        searchable={request.options.length > 6}
        onKey={onKey}
        collapsedGroups={
          request.collapsedGroup === undefined ? [] : [request.collapsedGroup]
        }
        colors={colors}
        choices={request.options.map((option) => ({
          name: option.label,
          description: option.description,
          group: option.group,
        }))}
        onSelect={(index) => {
          const option = request.options[index];
          if (option !== undefined) host.answer(pending.sequence, option.value);
        }}
        onCancel={() => {
          host.cancel();
          onClose();
        }}
      />
    );
  if (request.type === "confirmation")
    return (
      <Picker
        title={request.message}
        colors={colors}
        onKey={onKey}
        choices={[
          { name: request.confirmLabel ?? "Confirm" },
          { name: request.cancelLabel ?? "Cancel" },
        ]}
        onSelect={(index) => host.answer(pending.sequence, index === 0)}
        onCancel={() => {
          host.cancel();
          onClose();
        }}
      />
    );
  return (
    <TextPrompt
      host={host}
      pending={pending}
      colors={colors}
      onKey={(event) => {
        if (onKey(event)) {
          event.preventDefault();
          return;
        }
        if (event.name === "escape" || (event.ctrl && event.name === "c")) {
          event.preventDefault();
          host.cancel();
          onClose();
        }
      }}
    />
  );
}

/** Terminal renderer for one Whistle interaction host snapshot. */
export function InteractionView({
  host,
  colors,
  onRetry,
  onClose,
}: Readonly<{
  host: WhistleInteractionHost;
  colors: Colors;
  onRetry?: (() => void) | undefined;
  onClose: () => void;
}>) {
  const state = useSyncExternalStore(host.subscribe, host.snapshot);
  const copy = useCopyAction();
  // A short terminal keeps the question and drops the command title.
  const dimensions = useTerminalDimensions();
  const compact = dimensions.height < 14;
  // The Dialog surface is at most 68 cells wide, less its padding.
  const dialogWidth = Math.max(1, Math.min(68, dimensions.width - 2) - 4);
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
  const message = failed ? undefined : state.message;
  const tone =
    message?.type === "success"
      ? colors.success
      : message?.type === "progress"
        ? colors.warning
        : colors.info;
  const hints: readonly KeyHint[] = failed
    ? []
    : settled
      ? [{ keys: "Enter", label: "close", priority: 0 }]
      : state.prompt?.request.type === "text"
        ? [
            { keys: "Enter", label: "submit", priority: 0 },
            { keys: "Esc", label: "cancel", priority: 1 },
          ]
        : state.prompt === undefined
          ? [{ keys: "Esc", label: "cancel", priority: 0 }]
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
          <text fg={colors.info} wrapMode="char">
            {terminalText(handoff.url)}
          </text>
          <text fg={colors.accent} onMouseDown={() => copy?.(handoff.url)}>
            c = copy link
            {state.prompt?.request.type === "text"
              ? " · Alt+C while typing"
              : ""}
          </text>
          {handoff.code === undefined ? null : (
            <box flexDirection="column">
              <text fg={colors.accent} attributes={1}>
                {terminalText(handoff.code)}
              </text>
              <text
                fg={colors.accent}
                onMouseDown={() => copy?.(handoff.code ?? "")}
              >
                x = copy code
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
              <text fg={colors.info} wrapMode="char">
                {terminalText(link.url)}
              </text>
              <text fg={colors.accent} onMouseDown={() => copy?.(link.url)}>
                c = copy link
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
          onClose={onClose}
          onKey={copyKey}
        />
      )}
      {failed ? (
        <box flexDirection="column" rowGap={compact ? 0 : 1}>
          <text fg={colors.error}>● {terminalText(state.failure ?? "")}</text>
          <Picker
            colors={colors}
            choices={[
              ...(onRetry === undefined ? [] : [{ name: "Try again" }]),
              { name: "Close" },
            ]}
            onSelect={(index) => {
              if (onRetry !== undefined && index === 0) onRetry();
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
      <HintRow hints={hints} width={dialogWidth} colors={colors} />
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
          onRetry={() => {
            store.close();
            open.retry();
          }}
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
