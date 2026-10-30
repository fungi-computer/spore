import { ScrollBoxRenderable } from "@opentui/core";
import {
  awaitingTakeover,
  useApprovalAwaiting,
  formatContextUsage,
  formatModelWithLevel,
} from "@fungi.computer/parakeet/headless";
import { tuiDraftStorage } from "../../button/index.js";
import {
  messageAuthor,
  terminalText,
  terminalCellWidth,
  fitFooterCaption,
  sigilGutterText,
  sigilGutterTotalWidth,
} from "../../button/index.js";
import { TerminalClientRows, useClientRowCommands } from "./client-rows.js";
import type { RowV1 } from "@fungi.computer/gills";
import type {
  ClientEntryV1,
  TuiPresentation,
  StopAllResult,
  TuiSandboxSource,
} from "../../button/index.js";
import {
  usePaneKit,
  usePaneViewport,
  usePaneFocused,
  usePanePresentation,
  usePaneKeyboard,
  useToast,
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
  useLastSessionReplyAt,
  type ParakeetCommandRuntime,
  type ParakeetDraftIdentity,
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
  useId,
  useSyncExternalStore,
} from "react";

import { TerminalComposer } from "./terminal-composer.js";
import { stopAllFailure, stopAllSummary } from "./stop-all-summary.js";
import {
  useTerminalCancellation,
  useTerminalBindings,
} from "./terminal-controls.js";
import { useThemeControls } from "../../button/index.js";
import { saveThemePreference, type ThemeName } from "../../button/index.js";
import { useSessionControls } from "./session-controls.js";
import { useReloadControls } from "./reload-controls.js";
import { sessionStateLabel } from "./session-state-label.js";
import {
  footerLayout,
  PaneStatusLine,
  usePaneStatus,
  type PaneStatusItem,
  type PaneTone,
} from "../../button/index.js";
import type { TuiModelSource } from "../../button/index.js";
import {
  useModelControls,
  usePermissionsControls,
} from "../../button/index.js";
import {
  AwaitingDecisionBox,
  useInteractionDialog,
} from "../../button/index.js";
import {
  homeFolder,
  MAX_APPROVAL_DENIAL_NOTE_LENGTH,
  useMcpFormApprovalSource,
  type McpApprovalSource,
} from "../../button/index.js";
import { SlashCompletionList } from "../../button/index.js";
import {
  TerminalTranscript,
  type EmptyConversationState,
} from "./transcript.js";
import { reportFailure } from "../../button/index.js";
import type { ServiceRebind } from "../../button/index.js";
import {
  ServiceRecoveryOverlay,
  useServiceRecovery,
} from "./service-recovery.js";

function reportApprovalFailure(cause: unknown) {
  reportFailure("mcp-approval-answer", cause);
}

const recoveryRequests = defineIdFamily({
  family: "tui-error-recovery",
  version: 1,
  kinds: { request: { prefix: "request" } },
});

export type TuiFrameProps = Readonly<{
  /** The project folder as shown to the person (home shortened to `~`). */
  folder?: string | undefined;
  interactionStore?: ParakeetInteractions | undefined;
  mcpApprovals?: McpApprovalSource | undefined;
  clients?: readonly ClientEntryV1[] | undefined;
  onOpen?:
    ((target: NonNullable<RowV1["open"]>) => void | Promise<void>) | undefined;
  /** The terminal's Whistle runtime; Parakeet adds its commands to it. */
  commands: ParakeetCommandRuntime;
  onExit?: (() => void) | undefined;
  onStopAll?: (() => Promise<StopAllResult>) | undefined;
  session: ParakeetSession;
  draftIdentity?: ParakeetDraftIdentity | undefined;
  initialTheme?: ThemeName | undefined;
  onThemeConfirm?: ((theme: ThemeName) => Promise<void>) | undefined;
  themeError?: string | undefined;
  modelSource?: TuiModelSource | undefined;
  sandboxSource?: TuiSandboxSource | undefined;
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
  /** Point this pane at the service service.json now names; absent for remote Sessions. */
  onRebindService?:
    ((signal: AbortSignal) => Promise<ServiceRebind>) | undefined;
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

export function TuiFrameContent({
  session,
  draftIdentity,
  ...props
}: TuiFrameContentProps) {
  const toast = useToast();
  return (
    <ParakeetProvider
      session={session}
      draftStorage={tuiDraftStorage}
      draftIdentity={draftIdentity}
      clients={props.clients}
      interactionStore={props.interactionStore}
      authorOf={messageAuthor}
      onToast={toast.show}
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

/** A footer notice: the dot owns a fixed column, so wrapped text never runs under it. */
function FooterNotice({
  color,
  inset,
  children,
  oneLine = false,
}: Readonly<{
  color: TuiPresentation["colors"]["error"];
  inset: number;
  children: string;
  oneLine?: boolean;
}>) {
  return (
    <box flexDirection="row" marginX={inset}>
      <text width={sigilGutterTotalWidth} flexShrink={0} fg={color}>
        {sigilGutterText("●")}
      </text>
      <text
        flexGrow={1}
        flexShrink={1}
        fg={color}
        wrapMode={oneLine ? "none" : "word"}
      >
        {children}
      </text>
    </box>
  );
}

function TuiFrameConversation({
  commands,
  interactionStore,
  mcpApprovals,
  applicationCommands,
  onExit,
  onStopAll,
  session,
  onOpen,
  initialTheme = "terminal",
  onThemeConfirm = saveThemePreference,
  themeError,
  modelSource,
  sandboxSource,
  folder,
  onTitled,
  reloadSources,
  onResume,
  onNew,
  onForked,
  inputHandoff,
  onObservationUnavailable,
  onRebindService,
  initialCommandError,
  initialCommandNotice,
}: TuiFrameContentProps) {
  const panelInstanceId = useId();
  const kit = usePaneKit();
  const stopAll =
    onStopAll === undefined
      ? undefined
      : async () => {
          // Both keyboard and slash callers share the same notification owner.
          // A rejected transport/discovery request must not become a notice.
          try {
            kit.toast(stopAllSummary(await onStopAll()));
          } catch (cause) {
            reportFailure("session-stop-all", cause);
            kit.toast(stopAllFailure(cause));
          }
        };
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
  useEffect(
    () =>
      kit.sessions.registerDraftCheckpoint?.(session, composer.checkpointDraft),
    [kit.sessions, session, composer.checkpointDraft],
  );
  const sessionStatus = useStatus();
  const lastReplyAt = useLastSessionReplyAt();
  const contributions = useClientContributions();
  const timeline = useTimeline();
  const placed = useMemo(
    () =>
      placeClientTimeline(
        contributions,
        timeline.commandAnchors,
        timeline.positionAnchors,
      ),
    [contributions, timeline.commandAnchors, timeline.positionAnchors],
  );
  const rowActions = useClientRowCommands(commands, onOpen);
  // Attention rows expose their own advertised commands; the pane stays
  // independent of extension protocols and never opens a prompt on arrival.
  const allAttention = contributions.flatMap(({ entryId, value }) =>
    value.panel
      .filter(
        (row) => row.tone === "attention" && (row.actions?.length ?? 0) > 0,
      )
      .map((row) => ({ entryId, row, key: JSON.stringify([entryId, row.id]) })),
  );
  // A row that asks for a decision belongs to the composer's queue, not to
  // this row-by-row selection.
  const asksForDecision = (row: (typeof allAttention)[number]["row"]) =>
    row.actions?.some((action) => action.awaiting !== undefined) === true;
  const attentionRows = allAttention.filter(({ row }) => !asksForDecision(row));
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
  const serviceRecovery = useServiceRecovery({
    observation: sessionStatus.observation.status,
    reconnect: sessionStatus.reconnect,
    onObservationUnavailable,
    rebindService: onRebindService,
    lastReplyAt,
  });
  const [recoveryCollapsed, setRecoveryCollapsed] = useState(false);
  useEffect(() => {
    if (serviceRecovery === undefined) setRecoveryCollapsed(false);
  }, [serviceRecovery === undefined]);
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
  const { status: sandboxStatus, refresh: refreshSandbox } =
    usePermissionsControls({ source: sandboxSource, commands, dialog, colors });
  useEffect(() => {
    if (sandboxSource !== undefined) void refreshSandbox();
  }, [
    sandboxSource,
    sessionStatus.status,
    sessionStatus.commandId,
    refreshSandbox,
  ]);
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
      const outcome = await commands.execute(
        { namespace: "shell", id: "command-line" },
        {
          origin: "slash",
        },
      );
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
  useEffect(() => {
    if (initialCommandError !== undefined)
      store.report({ tone: "error", message: initialCommandError });
    else if (initialCommandNotice !== undefined)
      store.report({ tone: "info", message: initialCommandNotice });
  }, [initialCommandError, initialCommandNotice, store]);
  const takeover = awaitingTakeover(slash.awaiting, composer.draft);
  // Esc may arrive through the terminal's cancel binding; the decision gets it.
  const decisionEscape = useRef<(() => void) | undefined>(undefined);
  const escapeDecision = () => {
    const escape = decisionEscape.current;
    if (escape === undefined) return false;
    escape();
    return true;
  };
  usePaneKeyboard((event) => {
    if (dialog.isOpen || !focused || inspectionActive.current) return false;
    if (event.name === "up" && event.meta && slash.awaiting.total > 0) {
      slash.store.awaiting.focus();
      return true;
    }
    return false;
  });
  const approvalWidth = width - 2;
  const awaitingApproval = {
    store: slash.store,
    enabled: focused,
    home: homeFolder(),
    width: approvalWidth,
    noteLimit: MAX_APPROVAL_DENIAL_NOTE_LENGTH,
    onFailure: reportApprovalFailure,
  };
  useApprovalAwaiting({ ...awaitingApproval, source: mcpApprovals });
  useApprovalAwaiting({
    ...awaitingApproval,
    source: useMcpFormApprovalSource({ session, enabled: focused }),
  });
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
          takeover !== undefined ||
          slash.interactions.open !== undefined ||
          inspectedRow !== undefined ||
          slash.open
        ? "prompt"
        : null,
    cancel: composer.cancel,
    stopAll,
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
      escapeDecision() ||
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
    serviceStatusOpen: serviceRecovery !== undefined,
    showServiceStatus: () => {
      setRecoveryCollapsed(false);
    },
    collapseServiceStatus: () => {
      if (serviceRecovery === undefined || recoveryCollapsed) return false;
      setRecoveryCollapsed(true);
      return true;
    },
    canCancel:
      sessionStatus.status !== "queued" &&
      busyStatuses.has(sessionStatus.status),
    canRetry,
    canContinue,
    commands,
    application: applicationCommands,
    cancellation,
    stopAll,
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
  const displayedState = cancellation.pending
    ? ({ kind: "cancelling" } as const)
    : sessionStatus.viewState;
  const chips = contributions
    .flatMap(({ value }, entryOrder) =>
      value.chips.map((chip) => ({ chip, entryOrder })),
    )
    .sort((a, b) => a.chip.order - b.chip.order || a.entryOrder - b.entryOrder);
  const waitingOnAnswer =
    (allAttention.length > 0 || slash.awaiting.total > 0) &&
    (displayedState.kind === "idle" ||
      displayedState.kind === "waiting_for_you");
  // A host-owned selection wins; without one, the last reply names the model.
  const footerModel = modelControls.selectedModel ?? timeline.model;
  // "● " is already exactly the shared gutter's two cells (dot, then the
  // cell every row's text column starts after), so this line already sits
  // in the same gutter as every other row without building one specially.
  // Only the host-selected model carries a thinking level; a reply's model does not.
  const footerModelIdentity =
    footerModel === undefined
      ? undefined
      : formatModelWithLevel(footerModel, modelControls.selectedReasoning);
  const footer = footerLayout({
    width: width - 2 * inset,
    status: `● ${sessionStateLabel(displayedState, waitingOnAnswer)}`,
    compactStatus: `● ${sessionStateLabel(displayedState, waitingOnAnswer)}`,
    model: footerModelIdentity,
    context:
      sessionStatus.context === undefined
        ? undefined
        : formatContextUsage(sessionStatus.context),
  });
  const footerModelText = footerModelIdentity;
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
      ...(sandboxStatus === undefined
        ? []
        : [
            {
              slot: "chips",
              order: 0,
              text:
                sandboxStatus.mode === "full-access"
                  ? "full access"
                  : sandboxStatus.mode === "workspace"
                    ? "workspace · sandboxed"
                    : "read-only · sandboxed",
              tone: sandboxStatus.available ? "muted" : "warning",
            } satisfies PaneStatusItem,
          ]),
    ],
    [footer.statusText, footer.modelText, statusTone, sandboxStatus],
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
        detailsRequest={detailsRequest}
        groupRequest={groupRequest}
        inputEnabled={focused && !dialog.isOpen && inspectedRow === undefined}
        presentation={presentation}
        sessionAddress={session.address}
        terminalWidth={width}
      />
      <box flexShrink={0}>
        {slash.open && !dialog.isOpen && takeover === undefined ? (
          <SlashCompletionList
            slash={slash}
            colors={colors}
            maxRows={maxRows}
            width={width - 2}
          />
        ) : null}
        {takeover === undefined ? null : (
          <AwaitingDecisionBox
            key={takeover.key}
            item={takeover}
            position={slash.awaiting.position}
            total={slash.awaiting.total}
            onLater={() => {
              slash.store.awaiting.later(takeover.key);
            }}
            colors={colors}
            surface={surface}
            width={width - 2 * inset}
            rows={height}
            active={focused && !dialog.isOpen}
            escapeRef={decisionEscape}
          />
        )}
        {/* The draft stays mounted while a decision has the composer, so it returns untouched. */}
        <box
          flexDirection="row"
          backgroundColor={surface}
          paddingX={1}
          paddingY={1}
          visible={takeover === undefined}
        >
          <text fg={colors.primary} width={2} flexShrink={0}>
            ›{" "}
          </text>
          <TerminalComposer
            focused={
              focused &&
              !dialog.isOpen &&
              !showingAttention &&
              takeover === undefined
            }
            readOnly={composer.recallState.kind === "recalling"}
            inputHandoff={inputHandoff}
            maxHeight={maxRows}
            colors={colors}
            onKeyDown={(event) => {
              const current = slashRef.current;
              if (
                focused &&
                !dialog.isOpen &&
                !showingAttention &&
                !current.open &&
                event.name === "up" &&
                event.eventType === "press" &&
                !event.repeated &&
                !event.ctrl &&
                !event.meta &&
                !event.shift &&
                !event.option &&
                !event.super &&
                !event.hyper &&
                draft.current === "" &&
                (composer.images?.length ?? 0) === 0
              ) {
                event.preventDefault();
                void composer.recall();
                return;
              }
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
        {composer.admissionError !== undefined ? (
          <FooterNotice color={colors.warning} inset={inset}>
            {composer.admissionError === "offline_queue_full"
              ? "One prompt is already queued; it sends when the service is back."
              : "Too many prompts are still awaiting admission. Try again shortly."}
          </FooterNotice>
        ) : null}
        {composer.recallState.kind === "recalling" ? (
          <text fg={colors.foreground} attributes={2}>
            Recalling queued message…
          </text>
        ) : null}
        {(composer.images?.length ?? 0) > 0 ? (
          <text fg={colors.foreground} attributes={2}>
            {String(composer.images?.length)} attached image(s)
          </text>
        ) : null}
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
              !allAttention.some(
                (item) => item.entryId === entryId && item.row === row,
              ),
          );
          // A postponed or starting decision waits here; the one in the
          // composer is not also a row.
          const parked = rows.flatMap((row) => {
            const key = JSON.stringify([entryId, row.id]);
            if (!asksForDecision({ ...row }) || key === takeover?.key)
              return [];
            const place = slash.awaiting.items.findIndex(
              (item) => item.key === key,
            );
            // One line per row: the title gives way so the count and the
            // key always show, in the composer's own `1 of 3` words.
            const detail = [
              place >= 0 && slash.awaiting.total > 1
                ? `${String(place + 1)} of ${String(slash.awaiting.total)}`
                : undefined,
              "Alt+↑ answer",
            ]
              .filter(Boolean)
              .join(" · ");
            return [
              {
                ...row,
                title: fitFooterCaption(
                  terminalText(row.title),
                  Math.max(
                    1,
                    width -
                      2 * inset -
                      sigilGutterTotalWidth -
                      terminalCellWidth(detail) -
                      3,
                  ),
                ),
                detail,
              },
            ];
          });
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
            parked.length === 0 &&
            footerExtras.length === 0 ? null : (
            <TerminalClientRows
              key={entryId}
              id={`client-panel:${JSON.stringify([panelInstanceId, entryId])}`}
              rows={[...ordinary, ...footerExtras, ...attention, ...parked]}
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
          <FooterNotice color={colors.error} inset={inset}>
            {terminalText(themeControls.error)}
          </FooterNotice>
        ) : null}
        {notice !== undefined && !dialog.isOpen ? (
          <FooterNotice color={colors[noticeColors[notice.tone]]} inset={inset}>
            {terminalText(notice.message)}
          </FooterNotice>
        ) : null}
        {modelControls.loginNotice !== undefined && !dialog.isOpen ? (
          <FooterNotice color={colors.info} inset={inset}>
            {modelControls.loginNotice}
          </FooterNotice>
        ) : null}
        {serviceRecovery !== undefined && recoveryCollapsed ? (
          <FooterNotice color={colors.warning} inset={inset} oneLine>
            {serviceRecovery.phase === "incompatible"
              ? `${serviceRecovery.message} · Ctrl+B shows details`
              : serviceRecovery.phase === "stuck" &&
                  serviceRecovery.alive === false
                ? "The service stopped. Run `fungi resume`. · Ctrl+B shows details"
                : serviceRecovery.phase === "stuck" &&
                    serviceRecovery.alive === true
                  ? `Service busy (no reply for ${String(serviceRecovery.seconds)}s) · Ctrl+B shows details`
                  : "Reconnecting to the service... · Ctrl+B shows details"}
          </FooterNotice>
        ) : null}
      </box>
      {serviceRecovery === undefined || recoveryCollapsed ? null : (
        <ServiceRecoveryOverlay
          view={serviceRecovery}
          colors={colors}
          onClose={() => {
            setRecoveryCollapsed(true);
          }}
        />
      )}
    </box>
  );
}
