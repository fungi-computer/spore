import * as Redacted from "effect/Redacted";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type FailureReport = Readonly<{
  timestamp: string;
  pid: number;
  operation: string;
  errorKind: "error" | "non-error";
  errorName: string | undefined;
  cause: Redacted.Redacted<unknown>;
}>;

const maximumLogBytes = 1_048_576;
const defaultPath = () => join(homedir(), ".fungi", "logs", "tui.jsonl");

/** A class-like error name (TimeoutError, AbortError) says what failed without its text. */
function errorName(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(cause.name) ? cause.name : "Error";
}

/**
 * Diagnostics never share the renderer's stdout/stderr, even after teardown or
 * from a late callback. Keep one bounded log and one rotation. A failed log
 * write is best-effort (false), never a recursive stderr fallback or UI failure.
 * Causes remain redacted: exception text and tool input can contain credentials.
 */
export function reportFailure(
  operation: string,
  cause: unknown,
  path = defaultPath(),
): boolean {
  const report: FailureReport = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    operation,
    errorKind: cause instanceof Error ? "error" : "non-error",
    errorName: errorName(cause),
    cause: Redacted.make(cause),
  };
  const line = `${JSON.stringify(report)}\n`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    if (existsSync(path)) chmodSync(path, 0o600);
    if (existsSync(`${path}.1`)) chmodSync(`${path}.1`, 0o600);
    if (
      existsSync(path) &&
      statSync(path).size + Buffer.byteLength(line) > maximumLogBytes
    )
      renameSync(path, `${path}.1`);
    appendFileSync(path, line, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
