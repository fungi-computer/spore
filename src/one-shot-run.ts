import { terminalText } from "./button/terminal-text.js";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { replayKey } from "@fungi.computer/cairn";
import * as Effect from "effect/Effect";
import type {
  Accepted,
  PromptCommand,
  SessionFrame,
  SessionMessage,
  SessionTerminal,
  ShiitakeSession,
} from "@fungi.computer/shiitake";
import { userFacingCause } from "./panes/conversation/user-facing-cause.js";
import { runTuiEffect } from "./effect-boundary.js";
import { reportFailure } from "./button/log-event.js";

const MAX_PROMPT_BYTES = 256 * 1024;

export type OneShotSession = Readonly<{
  command: (input: PromptCommand) => Promise<Accepted>;
  watch: ShiitakeSession["watch"];
  abort: ShiitakeSession["abort"];
}>;

export type Input = NodeJS.ReadableStream &
  AsyncIterable<Buffer | string> & { isTTY?: boolean };
export type Output = Pick<NodeJS.WritableStream, "write"> & { isTTY?: boolean };
export type Signals = Readonly<{
  on: (signal: NodeJS.Signals, listener: () => void) => void;
  off: (signal: NodeJS.Signals, listener: () => void) => void;
}>;

export type OneShotRunOptions = Readonly<{
  prompt?: string | undefined;
  stdin?: Input | undefined;
  stdout?: Output | undefined;
  signals?: Signals | undefined;
  requestId?: string | undefined;
  /** Existing-host callers must not abort another client's accepted work. */
  abortOnSignal?: boolean | undefined;
}>;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export async function readOneShotPrompt(
  input: Input = process.stdin,
  signal?: AbortSignal,
): Promise<string> {
  if (input.isTTY === true)
    throw new Error("fungi run requires a prompt or piped stdin");
  let prompt = "";
  let bytes = 0;
  const decoder = new StringDecoder("utf8");
  const iterator = input[Symbol.asyncIterator]();
  let abort: (() => void) | undefined;
  const interrupted =
    signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          abort = () => {
            const reason: unknown = signal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error("fungi run cancelled", { cause: reason }),
            );
          };
          signal.addEventListener("abort", abort, { once: true });
        });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const next = iterator.next();
      const result =
        interrupted === undefined
          ? await next
          : await Promise.race([next, interrupted]);
      if (result.done === true) break;
      const buffer = Buffer.isBuffer(result.value)
        ? result.value
        : Buffer.from(result.value);
      bytes += buffer.byteLength;
      if (bytes > MAX_PROMPT_BYTES)
        throw new Error("fungi run prompt is too large");
      prompt += decoder.write(buffer);
    }
  } finally {
    if (abort !== undefined && signal !== undefined)
      signal.removeEventListener("abort", abort);
    try {
      await iterator.return?.();
    } catch (cause) {
      reportFailure("one-shot-prompt-iterator-close", cause);
    }
  }
  prompt += decoder.end();
  if (prompt.length === 0) throw new Error("fungi run prompt is empty");
  return prompt;
}

function assistantText(message: SessionMessage["value"]): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function frameMessages(frame: SessionFrame): readonly SessionMessage[] {
  if (frame.kind === "progress") return [];
  return frame.kind === "reset" ? frame.baseline.messages : frame.messages;
}

function frameTerminals(frame: SessionFrame): readonly SessionTerminal[] {
  if (frame.kind === "progress") return [];
  return frame.kind === "reset" ? frame.baseline.terminals : frame.terminals;
}

function oneShotFailure(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}

function throwOneShotFailures(failures: readonly Error[]): void {
  if (failures.length === 0) return;
  const firstFailure = failures[0];
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure;
  throw new AggregateError(failures, "fungi run failed");
}

function writeOutput(output: Output, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      output.write(text, (cause?: Error | null) => {
        if (cause === undefined || cause === null) resolve();
        else reject(cause);
      });
    } catch (cause) {
      reject(oneShotFailure(cause, "fungi run output failed"));
    }
  });
}

type CancellationState = {
  requested: boolean;
  accepted: boolean;
  abortStarted: boolean;
  abortFailure?: Error;
  abortPromise?: Promise<void>;
};

type ObservedWatch = Readonly<{
  watch: Awaited<ReturnType<OneShotSession["watch"]>>;
  changes: AsyncIterator<SessionFrame>;
}>;

async function closeObservedWatch(
  observed: ObservedWatch,
  failures: Error[],
  setWatchCloseFailure: (failure: Error) => void,
): Promise<void> {
  try {
    await observed.watch.close();
  } catch (cause) {
    setWatchCloseFailure(
      oneShotFailure(cause, "fungi run Session watch close failed"),
    );
  }
  try {
    await observed.changes.return?.();
  } catch (cause) {
    failures.push(oneShotFailure(cause, "fungi run Session watch stop failed"));
  }
}

type SettlementState = Readonly<{
  readonly correlatedSequence: number | undefined;
  readonly finalAssistant: SessionMessage | undefined;
  readonly terminal: SessionTerminal | undefined;
}>;

function reduceSettlementState(
  state: SettlementState,
  frame: SessionFrame,
  commandId: string,
): SettlementState {
  let correlatedSequence = state.correlatedSequence;
  let finalAssistant = state.finalAssistant;
  for (const message of frameMessages(frame)) {
    if (
      message.commandId === commandId &&
      message.value.role === "user" &&
      (correlatedSequence === undefined ||
        message.sequence < correlatedSequence)
    ) {
      correlatedSequence = message.sequence;
      finalAssistant = undefined;
    }
    if (
      correlatedSequence !== undefined &&
      message.value.role === "assistant" &&
      message.commandId === commandId &&
      message.sequence > correlatedSequence &&
      (finalAssistant === undefined ||
        message.sequence > finalAssistant.sequence)
    )
      finalAssistant = message;
  }
  let terminal = state.terminal;
  for (const candidate of frameTerminals(frame)) {
    if (candidate.commandId === commandId) terminal = candidate;
  }
  return { correlatedSequence, finalAssistant, terminal };
}

function throwIfRequested(cancellation: CancellationState): void {
  if (cancellation.requested) throw new Error("fungi run cancelled");
}

async function consumeSessionSettlement(
  changes: AsyncIterator<SessionFrame>,
  commandId: string,
  cancellation: CancellationState,
): Promise<SessionMessage> {
  let state: SettlementState = {
    correlatedSequence: undefined,
    finalAssistant: undefined,
    terminal: undefined,
  };
  for await (const frame of { [Symbol.asyncIterator]: () => changes }) {
    throwIfRequested(cancellation);
    if (frame.kind === "progress") continue;
    state = reduceSettlementState(state, frame, commandId);
    const terminal = state.terminal;
    if (terminal === undefined) continue;
    if (terminal.outcome !== "completed")
      throw new Error(
        terminal.outcome === "failed"
          ? userFacingCause(terminal.diagnostic)
          : `fungi run ${terminal.outcome}`,
      );
    if (state.finalAssistant === undefined)
      throw new Error("fungi run settled without a durable assistant result");
    return state.finalAssistant;
  }
  throw new Error(
    cancellation.requested
      ? "fungi run cancelled"
      : "fungi run Session watch ended before settlement",
  );
}

/** Run exactly one accepted prompt and print only its durable final assistant text. */
export async function runOneShot(
  session: OneShotSession,
  options: OneShotRunOptions = {},
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const signals = options.signals ?? process;
  const requestId = options.requestId ?? replayKey();
  const abortController = new AbortController();
  const cancellation: CancellationState = {
    requested: false,
    accepted: false,
    abortStarted: false,
  };
  const abortOnSignal = options.abortOnSignal ?? true;
  const failures: Error[] = [];
  let watchCloseFailure: Error | undefined;
  const onSignal = () => {
    if (cancellation.requested) return;
    cancellation.requested = true;
    startSessionAbort();
    abortController.abort();
  };
  const startSessionAbort = () => {
    if (
      !cancellation.requested ||
      !abortOnSignal ||
      !cancellation.accepted ||
      cancellation.abortStarted
    )
      return;
    cancellation.abortStarted = true;
    try {
      cancellation.abortPromise = Promise.resolve(session.abort()).then(
        () => undefined,
        (cause: unknown) => {
          cancellation.abortFailure = oneShotFailure(
            cause,
            "fungi run cancellation abort failed",
          );
        },
      );
    } catch (cause) {
      cancellation.abortFailure = oneShotFailure(
        cause,
        "fungi run cancellation abort failed",
      );
    }
  };
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          signals.on("SIGINT", onSignal);
          signals.on("SIGTERM", onSignal);
        }),
        () =>
          Effect.sync(() => {
            signals.off("SIGINT", onSignal);
            signals.off("SIGTERM", onSignal);
          }),
      );
      const prompt =
        options.prompt ??
        (yield* Effect.tryPromise({
          try: () => readOneShotPrompt(options.stdin, abortController.signal),
          catch: (cause) => oneShotFailure(cause, "fungi run prompt failed"),
        }));
      if (prompt.length === 0) throw new Error("fungi run prompt is empty");
      if (byteLength(prompt) > MAX_PROMPT_BYTES)
        throw new Error("fungi run prompt is too large");
      const observed = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const watch = await session.watch();
            return {
              watch,
              changes: watch.changes[Symbol.asyncIterator](),
            } satisfies ObservedWatch;
          },
          catch: (cause) => oneShotFailure(cause, "fungi run watch failed"),
        }),
        (value) =>
          Effect.promise(() =>
            closeObservedWatch(value, failures, (failure) => {
              watchCloseFailure = failure;
            }),
          ),
      );
      const { changes } = observed;
      const accepted: Accepted = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const accepted = yield* Effect.tryPromise({
            try: () =>
              session.command({
                type: "prompt",
                delivery: "followUp",
                requestId,
                text: prompt,
              }),
            catch: (cause) => oneShotFailure(cause, "fungi run prompt failed"),
          });
          if (accepted.commandId.length === 0)
            throw new Error("fungi run acceptance correlation failed");
          cancellation.accepted = true;
          if (cancellation.requested) startSessionAbort();
          return accepted;
        }),
      );
      throwIfRequested(cancellation);
      const finalAssistant = yield* Effect.tryPromise({
        try: () =>
          consumeSessionSettlement(changes, accepted.commandId, cancellation),
        catch: (cause) => oneShotFailure(cause, "fungi run failed"),
      });
      yield* Effect.tryPromise({
        try: () =>
          writeOutput(
            stdout,
            `${stdout.isTTY === true ? terminalText(assistantText(finalAssistant.value)) : assistantText(finalAssistant.value)}\n`,
          ),
        catch: (cause) => oneShotFailure(cause, "fungi run output failed"),
      });
    }),
  );
  try {
    await runTuiEffect(program, { signal: abortController.signal });
  } catch (cause) {
    failures.unshift(
      cancellation.requested
        ? new Error("fungi run cancelled")
        : oneShotFailure(cause, "fungi run failed"),
    );
  }
  if (cancellation.abortPromise !== undefined) await cancellation.abortPromise;
  if (cancellation.abortFailure !== undefined)
    failures.push(cancellation.abortFailure);
  if (watchCloseFailure !== undefined) failures.push(watchCloseFailure);
  throwOneShotFailures(failures);
}
