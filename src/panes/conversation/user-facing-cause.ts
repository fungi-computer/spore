/** `<area>:<reason>: ` diagnostic prefix that Shiitake puts before a human sentence. */
const diagnosticCode = /^([a-z]+):([a-z][a-z-]*):\s*/u;

const knownCodes: ReadonlyMap<string, string> = new Map([
  [
    "model:rejected",
    "No model is available. Run /login to sign in, then pick a model with /model.",
  ],
]);

const genericCause = "The request did not complete.";

/** Plain text for a stopped Session or run: never the internal diagnostic code. */
export function userFacingCause(cause: string | null | undefined): string {
  const trimmed = (cause ?? "").trim();
  const match = diagnosticCode.exec(trimmed);
  if (match === null) return trimmed === "" ? genericCause : trimmed;
  const code = `${match[1] ?? ""}:${match[2] ?? ""}`;
  const remainder = trimmed.slice(match[0].length).trim();
  // A bare code-only sentence says nothing the code's own plain text does not.
  const known = knownCodes.get(code);
  if (
    remainder === "" ||
    (known !== undefined && /^model acquisition failed\.?$/iu.test(remainder))
  )
    return known ?? genericCause;
  return remainder;
}
