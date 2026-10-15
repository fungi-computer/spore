import stripAnsi from "strip-ansi";

/** Display text keeps shaping characters, never terminal programs or bidi overrides. */
export function terminalText(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n?/gu, "\n")
    .replace(
      /[\p{Cc}\u200b\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069\u2060\ufeff]/gu,
      (character) =>
        character === "\n" || character === "\t" ? character : "",
    );
}
