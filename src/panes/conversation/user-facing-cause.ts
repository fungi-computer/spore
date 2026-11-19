/** `<area>:<reason>: ` diagnostic prefix that Shiitake puts before a human sentence. */
const diagnosticCode = /^([a-z]+):([a-z][a-z-]*):\s*/u;

const modelStartFailure =
  "The model couldn't start. Try /retry; if it keeps failing, run fungi doctor.";
const acquisitionFailure = /^model acquisition failed\.?$/iu;
const knownCodes: ReadonlyMap<string, string> = new Map([
  ["model:rejected", modelStartFailure],
]);

const genericCause = "The request did not complete.";

/** Plain text for a stopped Session or run: never the internal diagnostic code. */
export function userFacingCause(cause: string | null | undefined): string {
  const trimmed = (cause ?? "").trim();
  if (acquisitionFailure.test(trimmed)) return modelStartFailure;
  const match = diagnosticCode.exec(trimmed);
  if (match === null) return trimmed === "" ? genericCause : trimmed;
  const code = `${match[1] ?? ""}:${match[2] ?? ""}`;
  const remainder = trimmed.slice(match[0].length).trim();
  if (
    code === "model:rejected" &&
    remainder.startsWith("No signed-in model provider is available.")
  )
    return "No signed-in model provider is available. Use /login to sign in with your ChatGPT subscription, an API key, Fungi or an extension, then send your message again.";
  // A bare code-only sentence says nothing the code's own plain text does not.
  const known = knownCodes.get(code);
  if (
    remainder === "" ||
    (known !== undefined && acquisitionFailure.test(remainder))
  )
    return known ?? genericCause;
  return remainder;
}
