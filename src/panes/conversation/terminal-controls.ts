import { terminalExitCommandDefinitions } from "../../button/index.js";
import { nextTerminalEscape } from "./terminal-escape.js";
import {
  contributeTerminalCommands,
  terminalCommandDefinitions,
  type TerminalActions,
} from "./terminal-commands.js";
import { useCallback, useRef, useEffect, useState } from "react";
import type {
  ParakeetReconnectOutcome,
  ParakeetStatus,
} from "@fungi.computer/parakeet/headless";
import type {
  WhistleRuntime,
  WhistleContributionLease,
} from "@fungi.computer/whistle";

type CancellationAttempt = {
  commandId: string | undefined;
  request: Promise<void> | undefined;
};

const stopAllEscapeWindowMs = 600;

function boundedCancellation(
  operation: () => Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error("The local service did not answer the cancellation request"),
      );
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), deadline]).finally(
    () => {
      clearTimeout(timer);
    },
  );
}

/**
 * Own keyboard cancellation precedence; remote cancellation never owns exit.
 * Esc stops only the current turn; queued prompts keep draining. Ctrl+C exits locally
 * when work is queued, preserving input that has not started.
 */
export function useTerminalCancellation(
  input: Readonly<{
    commandId: string | undefined;
    dismissInteraction: () => boolean;
    notice?: boolean;
    dismissNotice?: () => void;
    status: ParakeetStatus;
    queued: boolean;
    waitingLabel: string | undefined;
    interaction: "prompt" | "actions" | null;
    cancel: () => Promise<void>;
    stopAll?: (() => Promise<void>) | undefined;
    cancelWaiting: () => Promise<void>;
    cancelRequestTimeoutMs?: number;
    onCancelFailure: (cause: unknown) => void;
    exit: (() => void) | undefined;
  }>,
) {
  const current = useRef(input);
  current.current = input;
  const armed = useRef(false);
  const previousEscape = useRef<number | undefined>(undefined);
  const cascade = useRef<Promise<void> | undefined>(undefined);
  const attempt = useRef<CancellationAttempt | undefined>(undefined);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (
      input.status === "idle" ||
      input.status === "error" ||
      input.status === "disconnected"
    )
      armed.current = false;
    const active = attempt.current;
    if (active === undefined) return;
    if (input.status === "idle" || input.status === "error") {
      attempt.current = undefined;
      setPending(false);
    } else if (active.commandId === undefined) {
      active.commandId = input.commandId;
    } else if (
      input.commandId !== undefined &&
      input.commandId !== active.commandId
    ) {
      attempt.current = undefined;
      setPending(false);
    }
  }, [input.commandId, input.status]);
  const requestCancellation = useCallback(
    (
      view: typeof input,
      target: "queued" | "active" | "waiting" = view.status === "queued"
        ? "queued"
        : view.status === "idle" && view.waitingLabel !== undefined
          ? "waiting"
          : "active",
    ): Promise<void> => {
      if (target === "queued" || target === "waiting") {
        setPending(true);
        return boundedCancellation(
          view.cancelWaiting,
          view.cancelRequestTimeoutMs,
        ).finally(() => {
          if (attempt.current === undefined) setPending(false);
        });
      }
      if (view.status === "cancelling") return Promise.resolve();
      const active = attempt.current;
      if (
        active !== undefined &&
        (active.commandId === undefined ||
          view.commandId === undefined ||
          active.commandId === view.commandId)
      )
        return active.request ?? Promise.resolve();
      const next: CancellationAttempt = {
        commandId: view.commandId,
        request: undefined,
      };
      attempt.current = next;
      setPending(true);
      const activeTurn =
        view.status !== "idle" &&
        view.status !== "error" &&
        view.status !== "disconnected";
      const operation = boundedCancellation(
        view.cancel,
        view.cancelRequestTimeoutMs,
      )
        .catch((cause: unknown) => {
          if (attempt.current === next) {
            next.request = Promise.resolve();
            setPending(false);
          }
          throw cause;
        })
        .finally(() => {
          if (!activeTurn && attempt.current === next) {
            attempt.current = undefined;
            setPending(false);
          }
        });
      next.request = operation;
      return operation;
    },
    [],
  );
  const keyboard = useCallback(
    (exitWhenIdle: boolean): Promise<void> => {
      const view = current.current;
      if (view.dismissInteraction()) {
        previousEscape.current = undefined;
        return Promise.resolve();
      }
      if (!exitWhenIdle) {
        const now = performance.now();
        const previous = previousEscape.current;
        previousEscape.current = now;
        if (
          view.stopAll !== undefined &&
          previous !== undefined &&
          now - previous <= stopAllEscapeWindowMs
        ) {
          previousEscape.current = undefined;
          if (cascade.current !== undefined) return Promise.resolve();
          cascade.current = view
            .stopAll()
            .catch((cause: unknown) => {
              current.current.onCancelFailure(cause);
            })
            .finally(() => {
              cascade.current = undefined;
            });
          return Promise.resolve();
        }
        const selected = nextTerminalEscape({
          interaction: view.interaction,
          notice: view.notice ?? false,
          queued: view.queued,
          status: view.status,
          cancellationPending: pending || attempt.current !== undefined,
          waitingLabel: view.waitingLabel,
        });
        if (selected.kind === "notice") {
          view.dismissNotice?.();
          return Promise.resolve();
        }
        if (selected.kind === "none" || selected.kind === "interaction")
          return Promise.resolve();
        void requestCancellation(view, selected.kind).catch(
          (cause: unknown) => {
            current.current.onCancelFailure(cause);
          },
        );
        return Promise.resolve();
      }

      previousEscape.current = undefined;

      if (
        view.status === "idle" ||
        view.status === "error" ||
        view.status === "disconnected"
      ) {
        armed.current = false;
        view.exit?.();
        return Promise.resolve();
      }
      if (
        view.status === "queued" ||
        view.waitingLabel !== undefined ||
        armed.current
      ) {
        view.exit?.();
        return Promise.resolve();
      }
      armed.current = exitWhenIdle;
      // A dead service may never settle its command request. Keep terminal
      // controls responsive so the next Ctrl+C can always exit locally.
      void requestCancellation(view).catch((cause: unknown) => {
        current.current.onCancelFailure(cause);
      });
      return Promise.resolve();
    },
    [requestCancellation, pending],
  );
  const cancel = useCallback(() => {
    const view = current.current;
    return requestCancellation(view);
  }, [requestCancellation]);
  return { keyboard, cancel, pending };
}

/** Attach selected-client controls and restore unconditional exit on retirement. */
export function useTerminalBindings(
  input: Readonly<{
    commands: Pick<WhistleRuntime, "contribute">;
    application: Readonly<{
      lease: WhistleContributionLease;
      exit: () => void;
    }>;
    cancellation: ReturnType<typeof useTerminalCancellation>;
    stopAll?: (() => Promise<void>) | undefined;
    reconnect: () => Promise<ParakeetReconnectOutcome>;
    canCancel: boolean;
    canRetry: boolean;
    canContinue: boolean;
    retry: () => boolean;
    continue: () => Promise<boolean>;
    details: () => void;
    toolGroup: () => void;
  }>,
) {
  const view = useRef(input);
  view.current = input;
  const { commands, application } = input;
  const controls = useRef<WhistleContributionLease | undefined>(undefined);
  const actions = (): Readonly<TerminalActions> => ({
    canCancel: view.current.canCancel,
    canRetry: view.current.canRetry,
    canContinue: view.current.canContinue,
    stopAll: view.current.stopAll,
    cancel: (origin) =>
      origin === "keyboard"
        ? view.current.cancellation.keyboard(false)
        : view.current.cancellation.cancel(),
    reconnect: () => view.current.reconnect(),
    retry: () => view.current.retry(),
    continue: () => view.current.continue(),
    details: () => {
      view.current.details();
    },
    toolGroup: () => {
      view.current.toolGroup();
    },
  });
  const definitions = () => terminalCommandDefinitions(actions());
  useEffect(() => {
    const lease = contributeTerminalCommands(commands, actions());
    controls.current = lease;
    try {
      application.lease.update(
        terminalExitCommandDefinitions({
          exit: undefined,
          ctrlC: () => view.current.cancellation.keyboard(true),
        }),
      );
    } catch (cause) {
      lease.dispose();
      throw cause;
    }
    return () => {
      try {
        application.lease.update(
          terminalExitCommandDefinitions({
            exit: undefined,
            ctrlC: () => {
              application.exit();
              return Promise.resolve();
            },
          }),
        );
      } finally {
        lease.dispose();
      }
    };
  }, [commands, application]);
  useEffect(() => {
    controls.current?.update(definitions());
  }, [input.canCancel, input.canRetry, input.canContinue]);
}
