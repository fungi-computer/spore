import { ScrollBoxRenderable } from "@opentui/core";
import {
  formatContextUsage,
  formatModelIdentity,
} from "@fungi.computer/parakeet/headless";
import {
  terminalText,
  terminalCellWidth,
  fitFooterCaption,
  sigilGutterText,
} from "../../button/index.js";
import { TerminalClientRows, useClientRowCommands } from "./client-rows.js";
import type { RowV1 } from "@fungi.computer/gills";
import type { ClientEntryV1 } from "../../button/index.js";
import {
  usePaneKit,
  usePaneViewport,
  usePaneFocused,
  usePanePresentation,
  usePaneKeyboard,
} from "../../button/index.js";
import { defineIdFamily } from "../../button/index.js";
import type { WhistleContributionLease } from "@fungi.computer/whistle";
import {
  ParakeetProvider,
  useComposer,
  useClientContributions,
  useTimeline,
  placeClientTimeline,
  useSlashCommands,
  useStatus,
  type ParakeetCommandRuntime,
  type ParakeetSession,
  type ParakeetInteractions,
  type SlashCommandController,
  type ReloadSource,
} from "@fungi.computer/parakeet/headless";
import {
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { TerminalComposer } from "./terminal-composer.js";
import {
  useTerminalCancellation,
  useTerminalBindings,
} from "./terminal-controls.js";
import { useThemeControls } from "../../button/index.js";
import { saveThemePreference, type ThemeName } from "../../button/index.js";
import { useSessionControls } from "./session-controls.js";
import { useReloadControls } from "./reload-controls.js";
import {
  sessionStateLabel,
  compactSessionStateLabel,
} from "./session-state-label.js";
import {
  footerLayout,
  PaneStatusLine,
  usePaneStatus,
  type PaneStatusItem,
  type PaneTone,
} from "../../button/index.js";
import type { TuiModelSource } from "../../button/index.js";
import { useModelControls } from "../../button/index.js";
import { useInteractionDialog } from "../../button/index.js";
import { SlashCompletionList } from "../../button/index.js";
import {
  TerminalTranscript,
  type EmptyConversationState,
} from "./transcript.js";
import { reportFailure } from "../../button/index.js";

const recoveryRequests = defineIdFamily({
  family: "tui-error-recovery",
  version: 1,
  kinds: { request: { prefix: "request" } },
});

export type TuiFrameProps = Readonly<{
  /** The project folder as shown to the person (home shortened to `~`). */
  folder?: string | undefined;
  interactionStore?: ParakeetInteractions | undefined;
  clients?: readonly ClientEntryV1[] | undefined;
  onOpen?:
    ((target: NonNullable<RowV1["open"]>) => void | Promise<void>) | undefined;
  /** The terminal's Whistle runtime; Parakeet adds its commands to it. */
  commands: ParakeetCommandRuntime;
  onExit?: (() => void) | undefined;
  session: ParakeetSession;
  initialTheme?: ThemeName | undefined;
  onThemeConfirm?: ((theme: ThemeName) => Promise<void>) | undefined;
  themeError?: string | undefined;
  modelSource?: TuiModelSource | undefined;
  /** The owner's current title, read when the derived title comes back. */
  sessionTitle?:
    ((signal: AbortSignal) => Promise<string | undefined>) | undefined;
  /** Show a title `/name` just saved; null means the derived title is back. */
  onTitled?: ((title: string | null) => void | Promise<void>) | undefined;
  /** Host-owned categories `/reload` reports beside the pane's own refreshes. */
  reloadSources?: readonly ReloadSource[] | undefined;
  onResume?: (() => void | Promise<void>) | undefined;
  onNew?: (() => void | Promise<void>) | undefined;
  onForked?: ((sessionId: string) => void | Promise<void>) | undefined;
  inputHandoff?:
    import("../../button/index.js").TerminalInputHandoff | undefined;
  onObservationUnavailable?: (() => boolean | Promise<boolean>) | undefined;
  initialCommandError?: string | undefined;
  initialCommandNotice?: string | undefined;
}>;

const statusColors = {
  idle: "success",
  waiting_for_you: "success",
  responding: "success",
  sending: "success",
  streaming: "success",
  thinking: "warning",
  queued: "warning",
  retrying: "warning",
  cancelling: "warning",
  running_tool: "warning",
  compacting: "warning",
  connecting: "warning",
  disconnected: "error",
  error: "error",
} as const;

export type TuiFrameContentProps = TuiFrameProps &
  Readonly<{
    applicationCommands: Readonly<{
      lease: WhistleContributionLease;
      exit: () => void;
    }>;
  }>;

export function TuiFrameContent({ session, ...props }: TuiFrameContentProps) {
  return (
    <ParakeetProvider
      session={session}
      clients={props.clients}
      interactionStore={props.interactionStore}
    >
      <TuiFrameConversation {...props} session={session} />
    </ParakeetProvider>
  );
}

const busyStatuses = new Set([
  "cancelling",
  "queued",
  "retrying",
  "sending",
  "streaming",
  "thinking",
]);

const noticeColors = {
  info: "info",
  success: "success",
  error: "error",
} as const;

function TuiFrameConversation({
  clients,
  commands,
  interactionStore,
  applicationCommands,
  onExit,
  session,
  onOpen,
  initialTheme = "terminal",
  onThemeConfirm = saveThemePreference,
  themeError,
  modelSource,
  folder,
  onTitled,
  reloadSources,
  onResume,
  onNew,
  onForked,
  inputHandoff,
  onObservationUnavailable,
  initialCommandError,
  initialCommandNotice,
}: TuiFrameContentProps) {
  const kit = usePaneKit();
  const focused = usePaneFocused();
  const dialogOpen = useSyncExternalStore(
    kit.dialogs.open.subscribe,
    kit.dialogs.open.read,
  );
  const dialog = {
    show: kit.dialogs.show,
    dismiss: kit.dialogs.dismiss,
    isOpen: dialogOpen,
  };
  const composer = useComposer();
  const sessionStatus = useStatus();
  const contributions = useClientContributions();
  const timeline = useTimeline();
  const placed = useMemo(
    () => placeClientTimeline(contributions, timeline.commandAnchors),
    [contributions, timeline.commandAnchors],
  );
  const rowActions = useClientRowCommands(commands, onOpen);
  // Attention rows expose their own advertised commands; the pane stays
  // independent of extension protocols and never opens a prompt on arrival.
  const attentionRows = contributions.flatMap(({ entryId, value }) =>
    value.panel
      .filter(
        (row) => row.tone === "attention" && (row.actions?.length ?? 0) > 0,
      )
      .map((row) => ({ entryId, row, key: JSON.stringify([entryId, row.id]) })),
  );
  const inspectionActive = useRef(false);
  const [attentionKey, setAttentionKey] = useState<string | null>(null);
  const [attentionFocused, setAttentionFocused] = useState(false);
  const attentionIndex = Math.max(
    0,
    attentionRows.findIndex((item) => item.key === attentionKey),
  );
  const selectedAttention = attentionRows[attentionIndex];
  const showingAttention = attentionFocused && selectedAttention !== undefined;
  useEffect(() => {
    if (attentionRows.length === 0) setAttentionFocused(false);
  }, [attentionRows.length]);
  usePaneKeyboard((event) => {
    if (dialog.isOpen || !focused || inspectionActive.current) return false;
    if (event.name === "up" && event.meta && selectedAttention !== undefined) {
      setAttentionFocused(true);
      return true;
    }
    if (!showingAttention) return false;
    if (event.name === "escape" || (event.name === "down" && event.meta)) {
      setAttentionFocused(false);
      return true;
    }
    if (event.name === "up" || event.name === "down") {
      const next =
        attentionRows[
          (attentionIndex +
            (event.name === "up" ? -1 : 1) +
            attentionRows.length) %
            attentionRows.length
        ];
      if (next !== undefined) setAttentionKey(next.key);
      return true;
    }
    if (event.name === "return") {
      const action = selectedAttention.row.actions?.[0];
      if (action !== undefined) {
        setAttentionFocused(false);
        void rowActions.execute(selectedAttention.entryId, action);
      }
      return true;
    }
    return false;
  });
  useEffect(() => {
    if (sessionStatus.observation.status !== "unavailable") return;
    const cancellation = new AbortController();
    const isCurrent = () => !cancellation.signal.aborted;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const recover = async () => {
      try {
        const upgraded = await onObservationUnavailable?.();
        if (!isCurrent() || upgraded) return;
        const outcome = await sessionStatus.reconnect();
        if (outcome.kind === "reconnected") return;
        if (!isCurrent()) return;
      } catch (cause) {
        reportFailure("session-observation-recovery", cause);
        if (!isCurrent()) return;
      }
      attempts += 1;
      timer = setTimeout(
        () => {
          void recover();
        },
        Math.min(1_000 * 2 ** attempts, 30_000),
      );
    };
    timer = setTimeout(() => {
      void recover();
    }, 1_000);
    return () => {
      cancellation.abort();
      clearTimeout(timer);
    };
  }, [
    sessionStatus.observation.status,
    sessionStatus.reconnect,
    onObservationUnavailable,
  ]);
  const themeControls = useThemeControls(dialog, {
    commands,
    initialTheme,
    initialError: themeError,
    confirm: onThemeConfirm,
  });
  const { presentation } = themeControls;
  usePanePresentation(presentation);
  const { colors, surface } = presentation;
  const modelControls = useModelControls({ source: modelSource, commands });
  useReloadControls({
    commands,
    refreshModels: modelControls.refresh,
    refreshColors: presentation.refresh,
    hostSources: reloadSources,
  });
  const slash = useSlashCommands({
    commands,
    origin: "slash",
    keys: { scroll: "PgUp/PgDn", queue: "Tab" },
    busy: busyStatuses.has(sessionStatus.status),
    interactionStore,
    showCommands: async () => {
      const outcome = await commands.execute("shell:command-line", {
        origin: "slash",
      });
      if (outcome.status !== "handled")
        throw new Error(
          outcome.status === "failed"
            ? outcome.error.message
            : "Commands are unavailable.",
        );
    },
  });
  const { store } = slash;
  const inspection = slash.interactions.inspection;
  const inspectedRow =
    inspection === undefined
      ? undefined
      : contributions
          .find((entry) => entry.entryId === inspection.entryId)
          ?.value.panel.find(
            (row) =>
              row.id === inspection.rowId && row.inspection !== undefined,
          );
  inspectionActive.current = inspectedRow !== undefined;
  const inspectionScroll = useRef<ScrollBoxRenderable>(null);
  const inspectionRows = inspectedRow?.inspection?.rows;
  const { width, height } = usePaneViewport();
  const [inspectionContent, setInspectionContent] = useState<
    Readonly<{
      rows: typeof inspectionRows;
      width: number;
      height: number;
    }>
  >();
  useLayoutEffect(() => {
    if (inspectionRows === undefined) return;
    const stop = kit.rendering.afterFrame(() => {
      const scroll = inspectionScroll.current;
      if (scroll !== null)
        setInspectionContent({
          rows: inspectionRows,
          width,
          height: scroll.scrollHeight,
        });
    });
    kit.rendering.requestFrame();
    return stop;
  }, [kit.rendering, inspectionRows, width]);
  const inspectionBodyHeight = Math.max(
    1,
    Math.min(
      12,
      Math.floor(height / 2) - 1,
      inspectionContent !== undefined &&
        inspectionContent.rows === inspectionRows &&
        inspectionContent.width === width
        ? inspectionContent.height
        : (inspectionRows?.length ?? 1),
    ),
  );
  const inspectionHeader = [
    inspectedRow?.inspection?.title,
    inspectedRow?.detail,
  ]
    .filter(Boolean)
    .join(" · ");
  const inspectionHints = "↑/↓ scroll · Esc back to draft";
  usePaneKeyboard((event) => {
    if (
      !focused ||
      dialog.isOpen ||
      slash.interactions.open !== undefined ||
      inspectedRow === undefined
    )
      return false;
    if (event.name === "escape") {
      store.inspect(undefined);
      return true;
    }
    const direction =
      event.name === "up" || event.name === "pageup"
        ? -1
        : event.name === "down" || event.name === "pagedown"
          ? 1
          : 0;
    if (direction === 0) return false;
    inspectionScroll.current?.scrollBy(
      direction,
      event.name.startsWith("page") ? "viewport" : "step",
    );
    return true;
  });
  const commandNotice = initialCommandNotice ?? modelControls.loginNotice;
  useEffect(() => {
    if (initialCommandError !== undefined)
      store.report({ tone: "error", message: initialCommandError });
    else if (commandNotice !== undefined)
      store.report({ tone: "info", message: commandNotice });
  }, [initialCommandError, commandNotice, store]);
  useInteractionDialog({
    dialog,
    colors,
    slash,
    inputHandoff,
    enabled: focused,
  });
  const inset = 1;
  const draft = useRef(composer.draft);
  draft.current = composer.draft;
  const slashRef = useRef<SlashCommandController>(slash);
  slashRef.current = slash;
  const [detailsRequest, setDetailsRequest] = useState(0);
  const [groupRequest, setGroupRequest] = useState(0);
  useSessionControls({
    session,
    commands,
    resume: onResume,
    create: onNew,
    onForked,
    onTitled,
    onEditQueued: (text) => {
      if (
        composer.draft.length === 0 ||
        composer.draft.trim() === "/queue edit-last"
      )
        composer.setDraft(text);
    },
    canEditQueued: () =>
      draft.current.length === 0 || draft.current.trim() === "/queue edit-last",
  });

  const waiting =
    sessionStatus.status === "idle"
      ? contributions.find(({ value }) => value.waiting !== null)
      : undefined;
  const hasQueued =
    timeline.queued.prompts.length > 0 ||
    sessionStatus.viewState.kind === "queued";
  const notice = slash.interactions.notice;
  const cancellation = useTerminalCancellation({
    notice: notice !== undefined,
    dismissNotice: () => {
      store.report(undefined);
    },
    commandId: sessionStatus.commandId,
    status: sessionStatus.status,
    queued: hasQueued,
    waitingLabel: waiting?.value.waiting?.cancel.label,
    interaction: rowActions.selecting
      ? "actions"
      : dialog.isOpen ||
          slash.interactions.open !== undefined ||
          inspectedRow !== undefined ||
          slash.open
        ? "prompt"
        : null,
    cancel: composer.cancel,
    onCancelFailure: (cause) => {
      store.report({
        tone: "error",
        message: `Cancellation could not reach the session: ${cause instanceof Error ? cause.message : String(cause)}. Press Ctrl+C again to exit; you can resume later.`,
      });
    },
    cancelWaiting: async () => {
      if (
        !hasQueued &&
        waiting?.value.waiting !== null &&
        waiting?.value.waiting !== undefined
      ) {
        await rowActions.execute(
          waiting.entryId,
          waiting.value.waiting.cancel,
          true,
        );
        return;
      }
      await composer.cancel();
    },
    exit: onExit,
    dismissInteraction: () =>
      dialog.dismiss() ||
      ((slash.open ||
        slash.interactions.open !== undefined ||
        inspectedRow !== undefined) &&
        slashRef.current.dismiss()),
  });
  const canRetry =
    composer.failure === "failed" ||
    composer.failure === "interrupted" ||
    composer.failure === "admission";
  const canContinue =
    sessionStatus.viewState.kind === "error" &&
    composer.failure !== "admission";
  useTerminalBindings({
    canCancel:
      sessionStatus.status !== "queued" &&
      busyStatuses.has(sessionStatus.status),
    canRetry,
    canContinue,
    commands,
    application: applicationCommands,
    cancellation,
    reconnect: sessionStatus.reconnect,
    retry: () => {
      if (!canRetry) return false;
      composer.retry();
      return true;
    },
    continue: async () => {
      if (!canContinue) return false;
      await session.command({
        type: "prompt",
        delivery: "followUp",
        requestId: recoveryRequests.request.generate(),
        text: "Continue the previous task. First address the error that stopped it.",
      });
      return true;
    },
    details: () => {
      setDetailsRequest((current) => current + 1);
    },
    toolGroup: () => {
      setGroupRequest((current) => current + 1);
    },
  });
  const maxRows = Math.max(1, Math.min(6, Math.floor(height / 3)));
  const [, refreshRetryCountdown] = useState(0);
  useEffect(() => {
    if (sessionStatus.viewState.kind !== "retrying") return;
    const timer = setInterval(() => {
      refreshRetryCountdown((value) => value + 1);
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [sessionStatus.viewState.kind]);
  const displayedState = cancellation.pending
    ? ({ kind: "cancelling" } as const)
    : sessionStatus.viewState;
  const chips = contributions
    .flatMap(({ value }, entryOrder) =>
      value.chips.map((chip) => ({ chip, entryOrder })),
    )
    .sort((a, b) => a.chip.order - b.chip.order || a.entryOrder - b.entryOrder);
  const waitingOnAnswer =
    attentionRows.length > 0 &&
    (displayedState.kind === "idle" ||
      displayedState.kind === "waiting_for_you");
  // A host-owned selection wins; without one, the last reply names the model.
  const footerModel = modelControls.selectedModel ?? timeline.model;
  // "● " is already exactly the shared gutter's two cells (dot, then the
  // cell every row's text column starts after), so this line already sits
  // in the same gutter as every other row without building one specially.
  const footer = footerLayout({
    width: width - 2 * inset,
    status: `● ${waitingOnAnswer ? "waiting on you" : sessionStateLabel(displayedState)}`,
    compactStatus: `● ${waitingOnAnswer ? "waiting on you" : compactSessionStateLabel(displayedState)}`,
    model:
      footerModel === undefined ? undefined : formatModelIdentity(footerModel),
    context:
      sessionStatus.context === undefined
        ? undefined
        : formatContextUsage(sessionStatus.context),
  });
  const footerModelText =
    footerModel === undefined ? undefined : formatModelIdentity(footerModel);
  const signInRequired = modelControls.signInRequired;
  const emptyState = useMemo<EmptyConversationState>(
    () => ({
      model: footerModelText,
      folder,
      signInRequired,
    }),
    [footerModelText, folder, signInRequired],
  );
  const statusTone: PaneTone = statusColors[displayedState.kind];
  const footerItems = useMemo<readonly PaneStatusItem[]>(
    () => [
      { slot: "state", order: 0, text: footer.statusText, tone: statusTone },
      { slot: "model", order: 1, text: footer.modelText, tone: "muted" },
    ],
    [footer.statusText, footer.modelText, statusTone],
  );
  usePaneStatus(footerItems);
  return (
    <box
      position="relative"
      backgroundColor={colors.background}
      flexDirection="column"
      height="100%"
      width="100%"
    >
      <TerminalTranscript
        emptyState={emptyState}
        clients={clients}
        detailsRequest={detailsRequest}
        groupRequest={groupRequest}
        inputEnabled={focused && !dialog.isOpen && inspectedRow === undefined}
        presentation={presentation}
        sessionAddress={session.address}
        terminalWidth={width}
      />
      <box flexShrink={0}>
        {slash.open && !dialog.isOpen ? (
          <SlashCompletionList
            slash={slash}
            colors={colors}
            maxRows={maxRows}
            width={width - 2}
          />
        ) : null}
        <box
          flexDirection="row"
          backgroundColor={surface}
          paddingX={1}
          paddingY={1}
        >
          <text fg={colors.primary} width={2} flexShrink={0}>
            ›{" "}
          </text>
          <TerminalComposer
            focused={focused && !dialog.isOpen && !showingAttention}
            inputHandoff={inputHandoff}
            maxHeight={maxRows}
            colors={colors}
            onKeyDown={(event) => {
              const current = slashRef.current;
              if (
                event.name === "tab" &&
                !event.shift &&
                !event.ctrl &&
                !event.meta
              ) {
                event.preventDefault();
                if (current.open) current.complete();
                else if (!draft.current.startsWith("/"))
                  current.submit("followUp");
                return;
              }
              if (
                current.open &&
                (event.name === "up" || event.name === "down")
              ) {
                event.preventDefault();
                current.move(event.name === "up" ? -1 : 1);
              }
            }}
            onChange={(value) => {
              draft.current = value;
              composer.setDraft(value);
            }}
            onSubmit={() => {
              slashRef.current.submit("steer");
            }}
            value={composer.draft}
          />
        </box>
        <PaneStatusLine inset={inset} />
        {contributions.map(({ entryId, value }) => {
          const rows =
            value.panel.length > 0
              ? value.panel
              : chips
                  .filter(
                    (chip) =>
                      contributions[chip.entryOrder]?.entryId === entryId,
                  )
                  .map(({ chip }) => chip.row);
          const ordinary = rows.filter(
            (row) =>
              !(
                inspection?.entryId === entryId && inspection.rowId === row.id
              ) &&
              !attentionRows.some(
                (item) => item.entryId === entryId && item.row === row,
              ),
          );
          // An extension's retained-event notice and null-anchor rows join
          // its own footer entry; one with no panel or chip row here keeps
          // none of this, rather than growing a block just to show it.
          const omittedHere = placed.omitted.find(
            (entry) => entry.entryId === entryId,
          );
          const footerExtras =
            rows.length === 0
              ? []
              : [
                  ...(omittedHere === undefined
                    ? []
                    : [
                        {
                          id: `omitted:${entryId}`,
                          title: `${String(omittedHere.count)} earlier change${omittedHere.count === 1 ? "" : "s"} omitted`,
                          tone: "muted" as const,
                        },
                      ]),
                  ...placed.unanchored
                    .filter((entry) => entry.entryId === entryId)
                    .flatMap(({ cell }) =>
                      cell.rows.map((row) => ({
                        ...row,
                        id: `unanchored:${cell.id}:${row.id}`,
                      })),
                    ),
                ];
          const selected =
            selectedAttention?.entryId === entryId
              ? selectedAttention.row
              : undefined;
          const attention =
            selected === undefined
              ? []
              : [
                  {
                    ...selected,
                    title: `${attentionRows.length > 1 ? `${String(attentionIndex + 1)}/${String(attentionRows.length)} · ` : ""}${selected.title}`,
                    detail: [
                      selected.detail,
                      showingAttention
                        ? `Enter ${selected.actions?.[0]?.label.toLowerCase() ?? "select"}${attentionRows.length > 1 ? " · ↑/↓ cycle" : ""} · Esc back to draft`
                        : `Alt+↑ ${selected.actions?.[0]?.label.toLowerCase() ?? "select"}`,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  },
                ];
          return ordinary.length === 0 &&
            attention.length === 0 &&
            footerExtras.length === 0 ? null : (
            <TerminalClientRows
              key={entryId}
              rows={[...ordinary, ...footerExtras, ...attention]}
              presentation={presentation}
              compactWidth={width - 2 * inset}
              expandedRowId={selected?.id}
              focusedRowId={showingAttention ? selected?.id : undefined}
              onOpen={
                onOpen === undefined
                  ? undefined
                  : (target) => {
                      void Promise.resolve(onOpen(target)).catch(
                        (cause: unknown) => {
                          reportFailure("client-row-open", cause);
                        },
                      );
                    }
              }
            />
          );
        })}
        {inspectedRow?.inspection === undefined ? null : (
          <box
            flexDirection="column"
            flexShrink={1}
            height={inspectionBodyHeight + 1}
          >
            <box
              flexDirection="row"
              justifyContent="space-between"
              marginX={inset}
              height={1}
            >
              <text fg={colors.foreground} wrapMode="none">
                {fitFooterCaption(
                  terminalText(inspectionHeader),
                  Math.max(0, width - 4 - terminalCellWidth(inspectionHints)),
                )}
              </text>
              <text fg={colors.foreground} attributes={2} wrapMode="none">
                {inspectionHints}
              </text>
            </box>
            <scrollbox
              ref={inspectionScroll}
              height={inspectionBodyHeight}
              flexShrink={0}
              contentOptions={{ minHeight: 0, flexGrow: 0 }}
              scrollX={false}
              horizontalScrollbarOptions={{ visible: false }}
              scrollbarOptions={{ showArrows: false }}
            >
              <TerminalClientRows
                rows={inspectedRow.inspection.rows}
                presentation={presentation}
              />
            </scrollbox>
          </box>
        )}
        {themeControls.error ? (
          <text fg={colors.error} marginX={inset}>
            {sigilGutterText("●")}
            {terminalText(themeControls.error)}
          </text>
        ) : null}
        {notice !== undefined && !dialog.isOpen ? (
          <text fg={colors[noticeColors[notice.tone]]} marginX={inset}>
            {sigilGutterText("●")}
            {terminalText(notice.message)}
          </text>
        ) : null}
      </box>
    </box>
  );
}
