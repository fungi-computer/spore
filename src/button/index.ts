/**
 * Button, the TUI's interface kit (named for a young mushroom): the only
 * surface a pane may use.
 *
 * Every pane (the conversation included) receives one {@link PaneKit} from the
 * shell and nothing else. Anything the conversation needs is added here, so
 * every other pane gets it too. `tests/architecture/tui-panes-public-api.test.ts`
 * enforces that panes import only this entry and public package exports.
 *
 * A kind is trusted TUI source registered in `panes/builtins.ts`; a declared
 * `launcher` puts it in **Open pane** without a shell edit. Apps reach the
 * terminal through Gills, which are admitted data, never pane code.
 */
import type {
  ParakeetSession,
  ParakeetDraftCheckpoint,
} from "@fungi.computer/parakeet/headless";
import type { StopAllResult } from "@fungi.computer/truffle/service";
import type { PaneCommands } from "@fungi.computer/nacre/command-host";
import type { Renderable, KeyEvent, PasteEvent } from "@opentui/core";
import { createElement, type ComponentType, type ReactNode } from "react";

import type { TuiPresentation } from "./presentation.js";
import type { ToastInput } from "./toast-store.js";

/** Outcome of the Agent-tree stop capability exposed to panes. */
export type { StopAllResult };
export { tuiDraftStorage } from "./draft-storage.js";
export {
  type TuiSandboxSource,
  type TuiSandboxStatus,
} from "./local-sandbox.js";

/** A read-only value that changes over the pane's lifetime. */
export type PaneValue<Value> = Readonly<{
  read: () => Value;
  /** Returns the unsubscribe function; the kit also drops it on dispose. */
  subscribe: (listener: () => void) => () => void;
}>;

/** The cells a pane owns; never the terminal's size. */
export type PaneViewport = Readonly<{ width: number; height: number }>;

/**
 * Focus-scoped input. The shell delivers a key to exactly one owner: shell
 * overlays first, then the focused pane. Handlers never run while the pane is
 * unfocused, and the key that focused the pane is not redelivered.
 */
export type PaneInput = Readonly<{
  focused: PaneValue<boolean>;
  /** Return true to consume the key; false lets the shell's layers see it. */
  onKey: (handler: (key: KeyEvent) => boolean) => () => void;
  onPaste: (handler: (event: PasteEvent) => void) => () => void;
  /** Ask the shell to focus this pane. */
  requestFocus: () => void;
}>;

/**
 * Pane-scoped commands. The shell stamps every contribution with this pane's
 * namespace and focus scope, so two panes of one kind coexist. Keys are
 * command `projections.bindings`; the shell's single keymap layer projects the
 * focused scope. Bindings are the command path; `onKey` handles raw text input.
 */
export type { PaneCommands } from "@fungi.computer/nacre/command-host";

/** One dialog on the shell's stack, drawn with the shell's dialog frame. */
export type PaneDialogHandle = Readonly<{
  dismiss: () => void;
  isCurrent: () => boolean;
}>;

export type PaneDialogs = Readonly<{
  show: (
    render: (handle: PaneDialogHandle) => ReactNode,
    options?: Readonly<{
      onDismiss?: () => void;
      /** Return false to keep the dialog open. */
      beforeDismiss?: () => boolean;
    }>,
  ) => PaneDialogHandle;
  open: PaneValue<boolean>;
  dismiss: () => boolean;
}>;

export type PaneTone = "info" | "success" | "warning" | "error" | "muted";

/**
 * Typed status-bar slots. The shell lays out the focused pane's items with the
 * single-row budget: `state` and `chips` left, `model` right. The status line
 * carries no key hints. `compact` replaces `text` before an item is dropped.
 */
export type PaneStatusSlot = "state" | "chips" | "model";

export type PaneStatusItem = Readonly<{
  slot: PaneStatusSlot;
  /** Ascending within a slot. */
  order: number;
  text: string;
  compact?: string;
  tone: PaneTone;
}>;

export type PaneStatus = Readonly<{
  items: PaneValue<readonly PaneStatusItem[]>;
  contribute: (item: PaneStatusItem) => Readonly<{
    update: (item: PaneStatusItem) => void;
    dispose: () => void;
  }>;
}>;

/**
 * Any open request: untrusted data each kind parses with its own schema. A
 * kind the registry does not know is refused.
 */
export type PaneTarget = Readonly<{
  kind: string;
  [field: string]: PaneTargetField;
}>;

/** Targets are flat data so any pane, Gill row or remote client can send one. */
export type PaneTargetField = string | number | boolean | null;

/**
 * The Session a conversation pane observes. A new Session carries the caller's
 * create-request key: one key per "new conversation" intent, reused on retry,
 * so a retried create after a transport failure admits at most one Session.
 */
export type PaneSessionTarget = Readonly<
  | { agentId: string; sessionId: string }
  | { agentId: string; sessionId: null; createRequestId: string }
>;

export type ConversationPaneTarget = PaneSessionTarget &
  Readonly<{
    kind: "conversation";
    /** Display metadata only; never used for Session admission. */
    title?: string;
  }>;

export type PaneOpenOutcome =
  | Readonly<{ kind: "opened" | "focused"; paneId: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** The admitted Session contract consumed by Parakeet conversation panes. */
export type PaneSession = ParakeetSession;

export type PaneSessionContext = Readonly<{
  agentName?: string | undefined;
  /** The Session's project folder as shown to the person. */
  folder?: string | undefined;
  themeName?: import("./theme-preferences.js").ThemeName | undefined;
  saveTheme?:
    | ((theme: import("./theme-preferences.js").ThemeName) => Promise<void>)
    | undefined;
  themeError?: string | undefined;
  resume?: ((paneId: string) => void | Promise<void>) | undefined;
  create?: ((paneId: string) => void | Promise<void>) | undefined;
  forked?:
    ((sessionId: string, paneId: string) => void | Promise<void>) | undefined;
  inputHandoff?:
    import("./terminal-input-handoff.js").TerminalInputHandoff | undefined;
  clients?:
    | readonly import("@fungi.computer/shiitake/client-entry").ClientEntryV1[]
    | undefined;
  interactions?:
    | import("@fungi.computer/parakeet/headless").ParakeetInteractions
    | undefined;
  mcpApprovals?: import("./mcp-approval.js").McpApprovalSource | undefined;
  models?: import("./model-query.js").TuiModelSource | undefined;
  sandbox?: import("./local-sandbox.js").TuiSandboxSource | undefined;
  stopAll?: (() => Promise<StopAllResult>) | undefined;
  /** The owner's current title: the user's title, else the first prompt's. */
  sessionTitle?:
    ((signal: AbortSignal) => Promise<string | undefined>) | undefined;
  /** Host-owned categories `/reload` reports: per-turn sources and fixed loads. */
  reload?:
    | readonly import("@fungi.computer/parakeet/headless").ReloadSource[]
    | undefined;
  observationUnavailable?:
    ((paneId: string) => boolean | Promise<boolean>) | undefined;
  /** Point the Session at the service service.json now names, after a restart. */
  rebindService?: ((signal: AbortSignal) => Promise<ServiceRebind>) | undefined;
  initialError?: string | undefined;
  initialNotice?: string | undefined;
}>;

/** A host-owned observation lease, not ownership of durable Session work. */
export type PaneSessionAcquisition = Readonly<{
  session: PaneSession;
  context: PaneSessionContext;
  close: () => Promise<void>;
}>;

export type PaneRendering = Readonly<{
  /** Schedule after native layout; the subscription is retired with the pane. */
  afterFrame: (callback: () => void) => () => void;
  requestFrame: () => void;
  isFocused: (renderable: Renderable) => boolean;
}>;

export type PaneSessions = Readonly<{
  describe?: (session: PaneSession) => PaneSessionContext;

  /** Register a live owner callback for a host handoff; never copies draft state. */
  registerDraftCheckpoint?:
    | ((
        session: PaneSession,
        checkpoint: () => ParakeetDraftCheckpoint,
      ) => () => void)
    | undefined;

  /**
   * Acquire one Session for this pane. Observation is released with the pane;
   * closing a pane never cancels durable work.
   */
  acquire: (
    target: PaneSessionTarget,
    signal: AbortSignal,
  ) => Promise<PaneSession>;
}>;

/** Credential-free App operations provided by the admitted Local account owner. */
export type PaneApps = Readonly<{
  /** True once a Fungi account with a selected Team can reach its Apps. */
  signedIn: (signal: AbortSignal) => Promise<boolean>;
  read: (
    signal: AbortSignal,
  ) => Promise<import("@fungi.computer/nacre/app-directory").AppDirectory>;
  requestGill: (
    surfaceId: string,
    request: import("@fungi.computer/gills").GillRequest,
    signal: AbortSignal,
  ) => Promise<import("@fungi.computer/gills").GillReply>;
  openUi: (surfaceId: string, signal: AbortSignal) => Promise<void>;
}>;

/** Everything a mounted pane may use. */
export type PaneKit = Readonly<{
  paneId: string;
  /** Update this pane’s display title; never changes its identity or authority. */
  setTitle: (title: string) => void;
  /** Explicit shell exit, available to every pane. */
  exit: () => void;
  rendering: PaneRendering;
  viewport: PaneValue<PaneViewport>;
  input: PaneInput;
  commands: PaneCommands;
  dialogs: PaneDialogs;
  status: PaneStatus;
  /** Replace this pane’s content in place; preserves its layout and identity. */
  replace: (target: PaneTarget) => Promise<PaneOpenOutcome>;
  /** Open a target in a new pane beside this one; an open target is focused. */
  open: (target: PaneTarget) => Promise<PaneOpenOutcome>;
  /** Show a transient message as a toast. */
  toast: (input: ToastInput) => void;
  sessions: PaneSessions;
  apps?: PaneApps | undefined;
  theme: PaneValue<TuiPresentation>;
  /** The focused pane's presentation also colors shell chrome and dialogs. */
  presentTheme: (presentation: TuiPresentation) => Readonly<{
    update: (presentation: TuiPresentation) => void;
    dispose: () => void;
  }>;
  /** Aborted when the pane closes, is replaced or its Team retires. */
  signal: AbortSignal;
  onDispose: (cleanup: () => void) => void;
  /** Resolve false to keep the pane open (e.g. a live terminal process). */
  guardClose: (guard: () => Promise<boolean>) => () => void;
  /** Human quit admission; signal/Team retirement still disposes directly. */
  guardQuit: (guard: () => Promise<boolean>) => () => void;
}>;

/**
 * A kind's **Open pane** row. The kind declares it; the shell lists it and
 * opens `target` through the ordinary registry path.
 */
export type PaneLauncher<Target extends PaneTarget = PaneTarget> = Readonly<{
  name: string;
  description: string;
  target: Target;
}>;

/** One pane kind: parses its target at the boundary and renders on the kit. */
export type PaneKind<Target extends PaneTarget> = Readonly<{
  kind: Target["kind"];
  parse: (target: PaneTarget) => Target | undefined;
  /** Same key → the shell focuses the open pane instead of opening another. */
  key: (target: Target) => string;
  title: (target: Target) => string;
  /** Omit when another pane or host flow supplies this kind's targets. */
  launcher?: PaneLauncher<Target>;
  View: ComponentType<Readonly<{ kit: PaneKit; target: Target }>>;
}>;

/** A registered kind with its target type closed over. */
export type PaneKindEntry = Readonly<{
  kind: string;
  launcher?: PaneLauncher | undefined;
  instantiate: (target: PaneTarget) => PaneInstance | undefined;
}>;

export type PaneInstance = Readonly<{
  key: string;
  title: string;
  /** Acquisition may finish asynchronously; the shell owns late-result cleanup. */
  render: (kit: PaneKit) => ReactNode | Promise<ReactNode>;
}>;

/** Register a pane kind; the parsed target never crosses as an untyped value. */
export function definePaneKind<Target extends PaneTarget>(
  definition: PaneKind<Target>,
): PaneKindEntry {
  return Object.freeze({
    kind: definition.kind,
    launcher: definition.launcher,
    instantiate: (target: PaneTarget) => {
      const parsed = definition.parse(target);
      if (parsed === undefined) return undefined;
      return Object.freeze({
        key: definition.key(parsed),
        title: definition.title(parsed),
        render: (kit: PaneKit) =>
          createElement(definition.View, { kit, target: parsed }),
      });
    },
  });
}

export type { TuiPresentation } from "./presentation.js";

/** Whether service.json now names a service that answers. */
export type ServiceRebind =
  Readonly<{ kind: "rebound" }> | Readonly<{ kind: "unavailable" }>;
export { applyNativeTerminalDefaults } from "./presentation.js";
export { reportFailure } from "./log-event.js";
export { footerLayout, fitFooterCaption } from "./footer-layout.js";
export { useThemeControls, useTerminalTheme } from "./terminal-theme.js";
export { saveThemePreference } from "./theme-preferences.js";
export type { ThemeName } from "./theme-preferences.js";
export { useModelControls } from "./model-controls.js";
export type { TuiModelSource } from "./model-query.js";
export { useDialog, DialogHost } from "./dialog.js";
export { DialogSurface } from "./dialog-surface.js";
export type { DialogController } from "./dialog.js";
export { useInteractionDialog } from "./interaction-dialog.js";
export {
  useMcpApprovalDialog,
  loadMcpApprovalSource,
  type McpApprovalSource,
} from "./mcp-approval.js";
export { useMcpFormApprovalDialog } from "./mcp-form-approval.js";
export { SlashCompletionList } from "./slash-completion.js";
export { CopySurface } from "./copy-surface.js";
export { toolCodeQuery } from "./tool-code-query.js";
export { TerminalMarkdown } from "./terminal-markdown.js";
export type { TerminalInputHandoff } from "./terminal-input-handoff.js";
export { useQuery } from "@tanstack/react-query";

export { defineIdFamily } from "@fungi.computer/cairn/id";
/** The host's reading of a message's metadata: who wrote the line. */
export { messageAuthor } from "@fungi.computer/agar/agents";

export {
  PaneProvider,
  usePaneKit,
  usePaneViewport,
  usePaneFocused,
  usePaneKeyboard,
  usePanePaste,
  useNativeFocus,
  paneCommandRuntime,
} from "./runtime.js";
export { z } from "zod";

export { Picker } from "./picker.js";
export { ToastProvider, useToast, toastDurationMs } from "./toast.js";
export type { ToastInput } from "./toast.js";
export { toneColor } from "./tone.js";

export { PaneStatusLine, usePaneStatus } from "./status.js";

export type { ClientEntryV1 } from "@fungi.computer/shiitake/client-entry";

export { usePanePresentation } from "./runtime.js";

export {
  contributeTerminalExitCommands,
  terminalExitCommandDefinitions,
} from "./terminal-exit.js";

export { terminalText } from "./terminal-text.js";

export { openLocalTerminal } from "./local-terminal.js";
export type { LocalTerminalFrame } from "./local-terminal.js";
export { openMacTerminal } from "./local-terminal-mac.js";
export { EmbeddedTerminalRenderable } from "./native-terminal.js";

export { stringWidth as terminalCellWidth } from "bun";
export { ToolSigilContext, useToolSigils } from "./tool-sigils.js";
export type { ToolSigils, ToolSigilGlyph } from "./tool-sigils.js";
export {
  ToolIcon,
  iconGutterWidth,
  sigilGutterText,
  sigilGutterWidth,
  sigilGutterTotalWidth,
} from "./sigil-gutter.js";

export { conversationNavigation } from "./conversation-navigation.js";
