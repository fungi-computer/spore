import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/** Run a TUI ownership Effect at the public Promise boundary without leaking FiberFailure. */
export async function runTuiEffect<Value, Failure extends Error>(
  effect: Effect.Effect<Value, Failure>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<Value> {
  const exit = await Effect.runPromiseExit(effect, options);
  if (Exit.isSuccess(exit)) return exit.value;
  const failures = [
    ...exit.cause.reasons
      .filter(Cause.isFailReason)
      .map((reason) => reason.error),
    ...exit.cause.reasons
      .filter(Cause.isDieReason)
      .map((reason) => reason.defect),
  ].map((cause) =>
    cause instanceof Error
      ? cause
      : new Error("TUI operation failed", { cause }),
  );
  if (failures.length > 1)
    throw new AggregateError(failures, "TUI operation and cleanup failed");
  const first = failures[0];
  if (first !== undefined) throw first;
  if (Cause.hasInterruptsOnly(exit.cause))
    throw options?.signal?.reason instanceof Error
      ? options.signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  const squashed = Cause.squash(exit.cause);
  if (squashed instanceof Error) throw squashed;
  throw new Error("TUI Effect failed without an Error cause");
}
