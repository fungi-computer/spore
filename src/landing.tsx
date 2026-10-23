import { homedir } from "node:os";
import type {
  PrivateLocalAgentChoice,
  PrivateLocalSessionChoice,
} from "@fungi.computer/truffle/service";
import { compactMushroom, fungiWordmark } from "@fungi.computer/lantern/banner";
import type { createRoot } from "@opentui/react";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { Picker } from "./button/picker.js";
import { useHostColors } from "./button/dialog-surface.js";
import { fitFooterCaption } from "./button/footer-layout.js";
import { terminalText } from "./button/terminal-text.js";
import { agentLabel } from "./agent-label.js";
import type { ThemeFrameProps } from "./tui-cli-contract.js";

/** What the person picked on the landing screen. */
export type LandingChoice =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "resume"; index: number }>
  | Readonly<{ kind: "agent"; index: number }>
  /** Archive the highlighted Agent, by its index in the Agent list. */
  | Readonly<{ kind: "archive"; index: number }>;

export type LandingRenderer = (
  root: ReturnType<typeof createRoot>,
  sessions: readonly PrivateLocalSessionChoice[],
  folder: string,
  choose: (choice: LandingChoice | undefined) => void,
  theme: ThemeFrameProps,
  /** More than one Agent: list them to pick from instead of conversations. */
  agents: readonly PrivateLocalAgentChoice[],
  /** Why the last action did nothing, such as an archive refused for a running command. */
  notice?: string,
) => void;

/** Signed-in account and the model a new Session would use. */
export type LandingSummary = Readonly<{
  account: string | undefined;
  model: string | undefined;
}>;

export type LandingProps = Readonly<{
  sessions: readonly PrivateLocalSessionChoice[];
  /** With several Agents, the landing lists them; one Agent lists its conversations. */
  agents?: readonly PrivateLocalAgentChoice[] | undefined;
  notice?: string | undefined;
  folder: string;
  loadSummary: (signal: AbortSignal) => Promise<LandingSummary>;
  choose: (choice: LandingChoice | undefined) => void;
}>;

const wordmark = fungiWordmark.replace(/^\n+|\n+$/gu, "");
const smallMark = compactMushroom.replace(/\n+$/u, "");

/** A project folder with the home directory shortened to `~`. */
export function displayFolder(folder: string) {
  const home = homedir();
  return folder === home || folder.startsWith(`${home}/`)
    ? `~${folder.slice(home.length)}`
    : folder;
}

function agentActivity(agent: PrivateLocalAgentChoice) {
  const count = `${String(agent.sessionCount)} conversation${agent.sessionCount === 1 ? "" : "s"}`;
  return agent.updatedAt === undefined
    ? count
    : `${count} · ${new Date(agent.updatedAt).toLocaleDateString()}`;
}

/** Bare `fungi`: who you are, which model, and your recent conversations. */
export function Landing({
  sessions,
  agents = [],
  notice,
  folder,
  loadSummary,
  choose,
}: LandingProps) {
  const colors = useHostColors();
  const { height, width } = useTerminalDimensions();
  // A changed Agent list restarts the picker, so a highlight is only good
  // for the list it was made in.
  const agentsKey = agents.map(({ agentId }) => agentId).join(",");
  const highlighted = useRef({ agentsKey, index: 0 });
  const [summary, setSummary] = useState<LandingSummary | "loading">("loading");
  useEffect(() => {
    const controller = new AbortController();
    loadSummary(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setSummary(value);
      },
      () => {
        if (!controller.signal.aborted)
          setSummary({ account: undefined, model: undefined });
      },
    );
    return () => {
      controller.abort();
    };
  }, [loadSummary]);
  const roomy = height >= 34 && width >= 72;
  const contentWidth = Math.max(1, Math.min(84, width - 4));
  const signedIn =
    summary !== "loading" &&
    (summary.account !== undefined || summary.model !== undefined);
  const detail = (label: string, value: string, muted = false) => (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={colors.foreground} attributes={2} width={9} flexShrink={0}>
        {label}
      </text>
      <text fg={colors.foreground} attributes={muted ? 2 : 0} wrapMode="none">
        {fitFooterCaption(terminalText(value), Math.max(0, contentWidth - 9))}
      </text>
    </box>
  );
  return (
    <box
      flexDirection="column"
      height={height}
      alignItems="center"
      paddingX={2}
      paddingTop={1}
      backgroundColor={colors.background}
    >
      <box
        flexDirection="column"
        width="100%"
        maxWidth={84}
        flexShrink={1}
        flexGrow={1}
        minHeight={0}
      >
        <box flexDirection="column" flexShrink={0}>
          <text fg={colors.primary} alignSelf="center">
            {roomy ? wordmark : smallMark}
          </text>
          <text
            fg={colors.foreground}
            attributes={2}
            marginBottom={1}
            alignSelf="center"
          >
            {roomy ? "Your ideas, growing." : "fungi · Your ideas, growing."}
          </text>
          {summary === "loading" ? (
            <>
              {detail("Account", "Checking…", true)}
              {detail("Model", "Checking…", true)}
            </>
          ) : (
            <>
              {detail("Account", summary.account ?? "Not signed in", !signedIn)}
              {detail(
                "Model",
                summary.model ?? "None yet",
                summary.model === undefined,
              )}
            </>
          )}
          {detail("Folder", displayFolder(folder))}
          {notice === undefined ? null : (
            <text fg={colors.info} marginTop={1} wrapMode="word">
              {terminalText(notice)}
            </text>
          )}
          {summary !== "loading" && !signedIn ? (
            <text fg={colors.info} marginTop={1}>
              Sign in to start: run fungi login, or type /login in a session.
            </text>
          ) : null}
        </box>
        <box flexDirection="column" flexGrow={1} minHeight={0} marginTop={1}>
          {agents.length > 1 ? (
            <Picker
              key={`agents-${agentsKey}`}
              title="Agents in this folder"
              colors={colors}
              descriptionWrap={false}
              choices={agents.map((agent) => ({
                name: agentLabel(agent, agents),
                description: agentActivity(agent),
              }))}
              hints={[
                { keys: "Enter", label: "open", priority: 0 },
                { keys: "a", label: "archive", priority: 1 },
                { keys: "↑↓", label: "choose", priority: 1 },
                { keys: "Esc", label: "quit", priority: 2 },
              ]}
              onHighlight={(index) => {
                highlighted.current = { agentsKey, index };
              }}
              onKey={(event) => {
                if (event.name !== "a" || event.ctrl || event.meta)
                  return false;
                choose({
                  kind: "archive",
                  index:
                    highlighted.current.agentsKey === agentsKey
                      ? highlighted.current.index
                      : 0,
                });
                return true;
              }}
              onSelect={(index) => {
                choose({ kind: "agent", index });
              }}
              onCancel={() => {
                choose(undefined);
              }}
            />
          ) : (
            <Picker
              key="conversations"
              title={
                sessions.length === 0
                  ? "No conversations in this folder yet"
                  : "Recent conversations"
              }
              colors={colors}
              descriptionWrap={false}
              choices={[
                { name: "+ New session", description: "n" },
                ...sessions.map((session) => ({
                  name: session.title.trim() || "Untitled",
                  description: new Date(session.updatedAt).toLocaleDateString(),
                })),
              ]}
              hints={[
                { keys: "Enter", label: "open", priority: 0 },
                { keys: "n", label: "new session", priority: 0 },
                { keys: "↑↓", label: "choose", priority: 1 },
                { keys: "Esc", label: "quit", priority: 2 },
              ]}
              onKey={(event) => {
                if (event.name !== "n" || event.ctrl || event.meta)
                  return false;
                choose({ kind: "new" });
                return true;
              }}
              onSelect={(index) => {
                choose(
                  index === 0
                    ? { kind: "new" }
                    : { kind: "resume", index: index - 1 },
                );
              }}
              onCancel={() => {
                choose(undefined);
              }}
            />
          )}
        </box>
      </box>
    </box>
  );
}
