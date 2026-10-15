export function asCliFailure(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}

export function combinedCliFailure(
  initiating: Error | undefined,
  cleanupFailures: readonly Error[],
) {
  const failures =
    initiating === undefined
      ? cleanupFailures
      : [initiating, ...cleanupFailures];
  if (failures.length === 1) {
    const [failure] = failures;
    if (failure === undefined) throw new Error("Missing local TUI failure");
    return failure;
  }
  return new AggregateError(failures, "Local TUI execution and cleanup failed");
}
