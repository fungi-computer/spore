import { sanitizeDisplayText } from "@fungi.computer/parakeet/headless";

/** Native text uses the shared conversation display-character policy. */
export function terminalText(value: string): string {
  return sanitizeDisplayText(value);
}
