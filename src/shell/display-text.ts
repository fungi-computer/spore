import { terminalText } from "../button/terminal-text.js";
/** Shell labels are plain terminal text, never terminal control sequences. */
export function displayText(value: string): string {
  return Array.from(terminalText(value).replace(/[\n\t]/gu, ""))
    .slice(0, 512)
    .join("");
}
