import type { ClientEntryV1 } from "@fungi.computer/shiitake/client-entry";
import type {
  PrivateLocalServiceSelection,
  PrivateLocalSessionChoice,
} from "@fungi.computer/truffle/service";
import type { PrivateLocalRuntimeHostOptions } from "@fungi.computer/truffle";

import type { TuiFrameProps } from "./frame.js";

export type TuiCliOptions = Readonly<{
  invocationRoot: string;
  extensions?: readonly string[] | undefined;
  /** Installed programs the project enabled, offered in Open pane. */
  paneKinds?: readonly import("./button/index.js").PaneKindEntry[] | undefined;
  clients?: readonly ClientEntryV1[] | undefined;
  questionExtensionId?: string | undefined;
  databasePath?: string | undefined;
  /** A person's selected permission mode for this Local Agent. */
  mode?: PrivateLocalServiceSelection["mode"];
  fungiMcp?: PrivateLocalServiceSelection["fungiMcp"];
  sessionId?: string | undefined;
  sessionChoice?: PrivateLocalSessionChoice | undefined;
  providerId?: string | undefined;
  modelId?: string | undefined;
  reasoning?: PrivateLocalRuntimeHostOptions["reasoning"];
  resume?: boolean | undefined;
  /** Bare fungi opens the landing; fungi new starts a new Session. */
  entry?: "landing" | "new" | undefined;
  last?: boolean | undefined;
  connect?: string | undefined;
  listen?: string | undefined;
  initialCommandError?: string | undefined;
}>;

export type ThemeFrameProps = Pick<
  TuiFrameProps,
  "initialTheme" | "themeError" | "onThemeConfirm" | "toolSigils"
>;

export type TuiFrameControls = {
  folder: string;
  setQuitGuard: NonNullable<TuiFrameProps["setQuitGuard"]>;
  acquireSession: NonNullable<TuiFrameProps["acquireSession"]>;
  apps?: TuiFrameProps["apps"];
  paneKinds?: TuiFrameProps["paneKinds"];
  commandHost: import("@fungi.computer/nacre/command-host").AppSurfaceCommandHost;
  target: import("./button/index.js").ConversationPaneTarget;
  replacePaneId?: string | undefined;
  openPlacement?: TuiFrameProps["openPlacement"];
  onClose: () => Promise<void>;
  openConversation: (
    placement?: TuiFrameProps["openPlacement"],
  ) => Promise<void>;
  chooseConversation: (
    placement?: TuiFrameProps["openPlacement"],
  ) => Promise<void>;
  clients?: TuiFrameProps["clients"];
  interactionStore?: TuiFrameProps["interactionStore"];
  inputHandoff?:
    | import("./button/terminal-input-handoff.js").TerminalInputHandoff
    | undefined;
  modelSource?: TuiFrameProps["modelSource"];
  sandboxSource?: TuiFrameProps["sandboxSource"];
  onStopAll?: TuiFrameProps["onStopAll"];
  sessionTitle?: TuiFrameProps["sessionTitle"];
  reloadSources?: TuiFrameProps["reloadSources"];
  onResume: NonNullable<TuiFrameProps["onResume"]>;
  onNew: NonNullable<TuiFrameProps["onNew"]>;
  onForked: NonNullable<TuiFrameProps["onForked"]>;
  onObservationUnavailable: NonNullable<
    TuiFrameProps["onObservationUnavailable"]
  >;
  onRebindService: TuiFrameProps["onRebindService"];
  initialCommandError?: string | undefined;
  initialCommandNotice?: string | undefined;
};
