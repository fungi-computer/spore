import * as Redacted from "effect/Redacted";
import { z } from "zod";
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

/** One error in a failure's cause chain: what it is, never what it said. */
type FailureLink = {
  name: string;
  code?: string;
  /** Schema problems as `code at path`, naming no value. */
  issues?: readonly string[];
};

type FailureReport = Readonly<{
  timestamp: string;
  pid: number;
  operation: string;
  errorKind: "error" | "non-error";
  errorName: string | undefined;
  /** The error and the errors that caused it, outermost first. */
  chain: readonly FailureLink[];
  cause: Redacted.Redacted<unknown>;
}>;

const maximumLogBytes = 1_048_576;
const defaultPath = () => join(homedir(), ".fungi", "logs", "tui.jsonl");

/** A class-like error name (TimeoutError, AbortError) says what failed without its text. */
function errorName(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(cause.name) ? cause.name : "Error";
}

const maximumChain = 4;
const maximumIssues = 4;
const maximumKeys = 8;
/**
 * A code, key or path segment that reads as a short schema field name, never
 * as prose or a secret: at most 32 characters, and not the start of a known
 * credential (a record keyed by a token must log as `*`).
 */
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/u;
const credentialPrefix =
  /^(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|sk_|pk_|rk_|xox[a-z]-|akia|asia|eyj|bearer|glpat-|npm_|ya29\.)/iu;
const identified = (value: string): string | undefined =>
  identifier.test(value) && !credentialPrefix.test(value) ? value : undefined;
const errorCode = z.object({
  code: z.string().refine((value) => identified(value) !== undefined),
});

/** The shape of a Zod failure this log can describe: codes and where, not what. */
const schemaFailure = z.object({
  issues: z.array(
    z.object({
      code: z.string(),
      path: z.array(z.union([z.string(), z.number()])),
      keys: z.array(z.string()).optional(),
    }),
  ),
});

function describeIssues(cause: Error): readonly string[] | undefined {
  const parsed = schemaFailure.safeParse(cause);
  if (!parsed.success) return undefined;
  return parsed.data.issues.slice(0, maximumIssues).map((issue) => {
    const where = issue.path.map(
      (segment) => identified(String(segment)) ?? "*",
    );
    const keys = (issue.keys ?? [])
      .slice(0, maximumKeys)
      .map((key) => identified(key) ?? "*");
    return `${identified(issue.code) ?? "unknown"} at ${where.join(".") || "(root)"}${keys.length === 0 ? "" : ` [${keys.join(",")}]`}`;
  });
}

/** Walk `cause` links so a wrapped failure (a pane that failed to mount) still names its root. */
function failureChain(cause: unknown): readonly FailureLink[] {
  const links: FailureLink[] = [];
  const seen = new Set<unknown>();
  for (
    let next = cause;
    next instanceof Error && !seen.has(next) && links.length < maximumChain;
    next = next.cause
  ) {
    seen.add(next);
    const link: FailureLink = {
      name: errorName(next) ?? "Error",
    };
    const code = errorCode.safeParse(next);
    if (code.success) link.code = code.data.code;
    const issues = describeIssues(next);
    if (issues !== undefined) link.issues = issues;
    links.push(link);
  }
  return links;
}

/**
 * Diagnostics never share the renderer's stdout/stderr, even after teardown or
 * from a late callback. Keep one bounded log and one rotation. A failed log
 * write is best-effort (false), never a recursive stderr fallback or UI failure.
 * Causes remain redacted: exception text and tool input can contain credentials.
 * The report adds what is safe to say: each error's class, an identifier-like
 * code, and a schema failure's codes, paths and unrecognized key names.
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
    chain: failureChain(cause),
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
