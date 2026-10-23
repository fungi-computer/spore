import type {
  ParakeetObservation,
  ParakeetReconnectOutcome,
} from "@fungi.computer/parakeet/headless";
import { useEffect, useState } from "react";
import {
  DialogSurface,
  reportFailure,
  terminalText,
  type ServiceRebind,
  type TuiPresentation,
} from "../../button/index.js";

export type ServiceRecoveryTiming = Readonly<{
  /** The first attempt to heal a lost connection; later ones double the wait. */
  firstAttemptAfterMs: number;
  /** A lost connection shorter than this shows nothing. */
  appearAfterMs: number;
  /** After this long, the overlay stops promising and says what to do. */
  stuckAfterMs: number;
  /** Retries back off up to this. */
  maxRetryDelayMs: number;
}>;

/** Injectable timer boundary; production uses the platform timers. */
export type RecoveryClock = Readonly<{
  schedule: (callback: () => void, milliseconds: number) => () => void;
}>;

const recoveryClock: RecoveryClock = {
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => {
      clearTimeout(timer);
    };
  },
};

const serviceRecoveryTiming: ServiceRecoveryTiming = {
  firstAttemptAfterMs: 250,
  appearAfterMs: 1_000,
  stuckAfterMs: 30_000,
  maxRetryDelayMs: 5_000,
};

/** What the pane shows while its service connection is being recovered. */
export type ServiceRecoveryView =
  | Readonly<{ phase: "incompatible"; message: string }>
  | Readonly<{ phase: "restarting" }>
  | Readonly<{ phase: "stuck"; lastError: string | undefined }>;

/**
 * Recover a lost Session observation. It re-reads service.json (the service
 * may be back on a new port), reopens the observation, and backs off between
 * attempts. The view appears only once the loss has lasted `appearAfterMs`,
 * so a blip that heals sooner shows nothing.
 */
export function useServiceRecovery(
  input: Readonly<{
    observation: ParakeetObservation["status"];
    reconnect: () => Promise<ParakeetReconnectOutcome>;
    /** Resolves true when the pane was replaced and recovery is moot. */
    onObservationUnavailable: (() => boolean | Promise<boolean>) | undefined;
    rebindService:
      ((signal: AbortSignal) => Promise<ServiceRebind>) | undefined;
    timing?: ServiceRecoveryTiming | undefined;
    clock?: RecoveryClock | undefined;
  }>,
): ServiceRecoveryView | undefined {
  const {
    observation,
    reconnect,
    onObservationUnavailable,
    rebindService,
    timing = serviceRecoveryTiming,
    clock = recoveryClock,
  } = input;
  const [view, setView] = useState<ServiceRecoveryView>();
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    // Opening a replacement watch is not recovery: only its valid snapshot
    // makes the observation live. Initial startup alone is not an outage.
    if (observation === "unavailable") setRecovering(true);
    else if (observation === "live") setRecovering(false);
  }, [observation]);
  useEffect(() => {
    if (!recovering) return;
    const cancellation = new AbortController();
    const isCurrent = () => !cancellation.signal.aborted;
    let shown = false;
    let stuck = false;
    let lastError: string | undefined;
    let terminalMessage: string | undefined;
    const publish = () => {
      setView(
        terminalMessage !== undefined
          ? { phase: "incompatible", message: terminalMessage }
          : !shown
            ? undefined
            : stuck
              ? { phase: "stuck", lastError }
              : { phase: "restarting" },
      );
    };
    let attempts = 0;
    let cancelRetry: (() => void) | undefined;
    const recover = async (): Promise<void> => {
      try {
        const replaced = await onObservationUnavailable?.();
        if (!isCurrent() || replaced) return;
        const rebound = await rebindService?.(cancellation.signal);
        if (!isCurrent()) return;
        if (rebound?.kind === "unavailable") {
          lastError = undefined;
        } else {
          const outcome = await reconnect();
          if (outcome.kind === "reconnected" || !isCurrent()) return;
          lastError = outcome.kind === "failed" ? outcome.cause : undefined;
        }
      } catch (cause) {
        reportFailure("session-observation-recovery", cause);
        if (!isCurrent()) return;
        // The service owner supplies typed errors. Do not infer compatibility
        // from prose (or retry a window whose loaded protocol cannot work).
        if (
          cause instanceof Error &&
          (cause.name === "LocalServiceUpdated" ||
            cause.name === "LocalServiceIncompatible")
        ) {
          terminalMessage = cause.message;
          cancelAppear();
          cancelGiveUp();
          publish();
          return;
        }
        lastError = cause instanceof Error ? cause.message : String(cause);
      }
      publish();
      schedule();
    };
    function schedule() {
      const wait = Math.min(
        timing.firstAttemptAfterMs * 2 ** attempts,
        timing.maxRetryDelayMs,
      );
      attempts += 1;
      cancelRetry = clock.schedule(() => {
        void recover();
      }, wait);
    }
    schedule();
    const cancelAppear = clock.schedule(() => {
      shown = true;
      publish();
    }, timing.appearAfterMs);
    const cancelGiveUp = clock.schedule(() => {
      shown = true;
      stuck = true;
      publish();
    }, timing.stuckAfterMs);
    return () => {
      cancellation.abort();
      cancelAppear();
      cancelGiveUp();
      cancelRetry?.();
      setView(undefined);
    };
  }, [
    recovering,
    reconnect,
    onObservationUnavailable,
    rebindService,
    timing,
    clock,
  ]);
  return view;
}

/** The pane's dialog-styled notice that its service connection is being restored. */
export function ServiceRecoveryOverlay({
  view,
  colors,
}: Readonly<{
  view: ServiceRecoveryView;
  colors: TuiPresentation["colors"];
}>) {
  return (
    <DialogSurface colors={colors} onClose={() => undefined}>
      {view.phase === "incompatible" ? (
        <text fg={colors.foreground} wrapMode="char">
          {terminalText(view.message)}
        </text>
      ) : view.phase === "restarting" ? (
        <>
          <text fg={colors.foreground} attributes={1}>
            Restarting the service...
          </text>
          <text fg={colors.foreground}>your session will resume</text>
        </>
      ) : (
        <>
          <text fg={colors.foreground} attributes={1}>
            The service is not answering
          </text>
          <text fg={colors.foreground}>
            Run `fungi resume` in another terminal to start it. This session
            keeps trying and resumes when the service is back; your draft is
            kept.
          </text>
          {view.lastError === undefined ? null : (
            <text fg={colors.error} wrapMode="char">
              {terminalText(view.lastError)}
            </text>
          )}
        </>
      )}
    </DialogSurface>
  );
}
