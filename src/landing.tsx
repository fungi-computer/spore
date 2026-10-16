import { homedir } from "node:os";
import type { PrivateLocalSessionChoice } from "@fungi.computer/truffle/service";
import { compactMushroom, fungiWordmark } from "@fungi.computer/lantern/banner";
import type { createRoot } from "@opentui/react";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { Picker } from "./button/picker.js";
import { useHostColors } from "./button/dialog-surface.js";
import { fitFooterCaption } from "./button/footer-layout.js";
import { terminalText } from "./button/terminal-text.js";
import type { ThemeFrameProps } from "./tui-cli-contract.js";

/** What the person picked on the landing screen. */
export type LandingChoice =
  Readonly<{ kind: "new" }> | Readonly<{ kind: "resume"; index: number }>;

export type LandingRenderer = (
  root: ReturnType<typeof createRoot>,
  sessions: readonly PrivateLocalSessionChoice[],
  folder: string,
  choose: (choice: LandingChoice | undefined) => void,
  theme: ThemeFrameProps,
) => void;

/** Signed-in account and the model a new Session would use. */
export type LandingSummary = Readonly<{
  account: string | undefined;
  model: string | undefined;
}>;

export type LandingProps = Readonly<{
  sessions: readonly PrivateLocalSessionChoice[];
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

/** Bare `fungi`: who you are, which model, and your recent conversations. */
export function Landing({
  sessions,
  folder,
  loadSummary,
  choose,
}: LandingProps) {
  const colors = useHostColors();
  const { height, width } = useTerminalDimensions();
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
          {summary !== "loading" && !signedIn ? (
            <text fg={colors.info} marginTop={1}>
              Sign in to start: run fungi login, or type /login in a session.
            </text>
          ) : null}
        </box>
        <box flexDirection="column" flexGrow={1} minHeight={0} marginTop={1}>
          <Picker
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
              if (event.name !== "n" || event.ctrl || event.meta) return false;
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
        </box>
      </box>
    </box>
  );
}
