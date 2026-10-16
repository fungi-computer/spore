import type {
  PrivateLocalServiceConnection,
  PrivateLocalServiceManager,
  PrivateLocalSessionChoice,
} from "@fungi.computer/truffle/service";
import type { createRoot } from "@opentui/react";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { LandingChoice, LandingRenderer } from "./landing.js";

import type { ThemeFrameProps, TuiCliOptions } from "./tui-cli-contract.js";

export type TuiSessionMount = Pick<
  PrivateLocalServiceConnection,
  | "agentId"
  | "databasePath"
  | "sessionId"
  | "session"
  | "effectiveModel"
  | "close"
>;

export type TuiSessionPickerRenderer = (
  root: ReturnType<typeof createRoot>,
  sessions: readonly PrivateLocalSessionChoice[],
  onSelect: (index: number) => void,
  onCancel: () => void,
  theme: ThemeFrameProps,
) => void;

/** Idempotency keys for creating a new Session through the Local service. */
export const sessionCreateRequests = defineIdFamily({
  family: "tui-session-create-request",
  version: 1,
  kinds: { request: { prefix: "request" } },
});

function discoveryProblemMessage(
  problems: readonly { kind: "corrupt" | "in_use" | "unreadable" }[],
) {
  const counts = new Map<string, number>();
  for (const problem of problems)
    counts.set(problem.kind, (counts.get(problem.kind) ?? 0) + 1);
  const details = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${String(count)} ${kind}`)
    .join(", ");
  return `Skipped ${String(problems.length)} saved conversation${problems.length === 1 ? "" : "s"} (${details}).`;
}

export function validateTuiSelection(options: TuiCliOptions): void {
  if (options.connect !== undefined)
    throw new Error(
      "--connect is unavailable; fungi uses the persistent Local service",
    );
  if (options.listen !== undefined)
    throw new Error(
      "--listen is unavailable until the shared Local service exposes client sharing",
    );
  if (
    options.providerId !== undefined ||
    options.modelId !== undefined ||
    options.reasoning !== undefined
  )
    throw new Error(
      "Session model selection requires the shared Local preference contract",
    );
}

/** Select one Session through the persistent Local service without owning it. */
export async function selectTuiSession(input: {
  options: TuiCliOptions;
  serviceManager: PrivateLocalServiceManager;
  discoverSessions?: PrivateLocalServiceManager["discover"] | undefined;
  renderPicker: TuiSessionPickerRenderer;
  renderLanding: LandingRenderer;
  root: ReturnType<typeof createRoot>;
  theme: ThemeFrameProps;
  signal: AbortSignal;
  destroyed: () => boolean;
  onNotice: (message: string) => void;
}): Promise<TuiSessionMount | undefined> {
  const {
    options,
    serviceManager,
    renderPicker,
    root,
    theme,
    signal,
    destroyed,
    onNotice,
  } = input;
  if (options.sessionChoice !== undefined)
    return options.sessionChoice.resume({ signal, fungiMcp: options.fungiMcp });
  if (
    (options.entry === "landing" || options.entry === "new") &&
    !options.resume
  ) {
    const discovery = await (input.discoverSessions ?? serviceManager.discover)(
      options.invocationRoot,
      { signal },
    );
    if (discovery.problems.length > 0)
      onNotice(discoveryProblemMessage(discovery.problems));
    const newest = discovery.sessions[0];
    const startNew = () =>
      newest === undefined
        ? serviceManager.connect(
            {
              invocationRoot: options.invocationRoot,
              fungiMcp: options.fungiMcp,
            },
            { signal },
          )
        : serviceManager.createSession(
            {
              invocationRoot: options.invocationRoot,
              databasePath: newest.databasePath,
              requestId: sessionCreateRequests.request.generate(),
              fungiMcp: options.fungiMcp,
            },
            { signal },
          );
    if (options.entry === "new") return startNew();
    if (destroyed()) return undefined;
    const choice = await new Promise<LandingChoice | undefined>((resolve) => {
      const cancel = () => {
        done(undefined);
      };
      const done = (picked: LandingChoice | undefined) => {
        signal.removeEventListener("abort", cancel);
        resolve(picked);
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }
      input.renderLanding(
        root,
        discovery.sessions,
        options.invocationRoot,
        done,
        theme,
      );
    });
    if (choice === undefined || destroyed()) return undefined;
    if (choice.kind === "new") return startNew();
    const picked = discovery.sessions[choice.index];
    if (picked === undefined) return undefined;
    return picked.resume({ signal, fungiMcp: options.fungiMcp });
  }
  const discovery =
    options.databasePath === undefined &&
    options.connect === undefined &&
    (options.resume || options.sessionId === undefined)
      ? await (input.discoverSessions ?? serviceManager.discover)(
          options.invocationRoot,
          { signal },
        )
      : undefined;
  if (discovery !== undefined && (options.resume || discovery.agentCount > 1)) {
    if (discovery.problems.length > 0)
      onNotice(discoveryProblemMessage(discovery.problems));
    const selected = discovery.sessions[0];
    if (selected === undefined)
      throw new Error(
        discovery.problems.length > 0
          ? discoveryProblemMessage(discovery.problems)
          : "No saved conversations in this folder",
      );
    validateTuiSelection(options);
    if (options.last)
      return selected.resume({ signal, fungiMcp: options.fungiMcp });
    if (destroyed()) return undefined;
    const picked = await new Promise<PrivateLocalSessionChoice | undefined>(
      (resolve) => {
        const cancel = () => {
          done(undefined);
        };
        const done = (choice: PrivateLocalSessionChoice | undefined) => {
          signal.removeEventListener("abort", cancel);
          resolve(choice);
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) {
          cancel();
          return;
        }
        renderPicker(
          root,
          discovery.sessions,
          (index) => {
            done(discovery.sessions[index]);
          },
          () => {
            done(undefined);
          },
          theme,
        );
      },
    );
    if (picked === undefined || destroyed()) return undefined;
    return picked.resume({ signal, fungiMcp: options.fungiMcp });
  }
  if (options.connect !== undefined)
    throw new Error(
      "--connect is unavailable; fungi uses the persistent Local service",
    );
  if (options.listen !== undefined)
    throw new Error(
      "--listen is unavailable until the shared Local service exposes client sharing",
    );
  validateTuiSelection(options);
  const selection: Parameters<PrivateLocalServiceManager["connect"]>[0] =
    options.databasePath === undefined
      ? {
          invocationRoot: options.invocationRoot,
          fungiMcp: options.fungiMcp,
          sessionId: options.sessionId,
        }
      : {
          invocationRoot: options.invocationRoot,
          fungiMcp: options.fungiMcp,
          databasePath: options.databasePath,
          sessionId: options.sessionId,
        };
  return serviceManager.connect(selection, { signal });
}
