import { expect, test } from "bun:test";
import { terminalText } from "../src/button/terminal-text.js";

test("terminal text removes OSC, CSI, C1 and format controls but preserves ordinary Unicode and layout", () => {
  const clean = "Hello 🪴 café\n\tsecond line";
  expect(terminalText(clean)).toBe(clean);
  expect(
    terminalText(
      `\u001b]0;spoof\u0007\u001b]52;c;Y21k\u0007\u001b]8;;https://evil.test\u001b\\${clean}\u001b]8;;\u001b\\\u001b[2J\u001b[H\u009b2J\u0007\u202e\u2066\u0000`,
    ),
  ).toBe(clean);
  expect(terminalText("\u001b]52;c;unfinished")).not.toMatch(
    /[^\P{Cc}\n\t]|\p{Cf}/u,
  );
});

test("shell labels cap Unicode code points without splitting an emoji and remove bidi controls", async () => {
  const { displayText } = await import("../src/shell/display-text.js");
  expect(displayText(`${"a".repeat(511)}🪴tail`)).toBe(`${"a".repeat(511)}🪴`);
  expect(displayText("safe\u202e\u2066\n\tlabel")).toBe("safelabel");
});

test("terminal text preserves shaping and normalizes CR while rejecting every C1 and bidi control", () => {
  const visible =
    "👨‍👩‍👧 👩‍💻 🏳️‍🌈 🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f} می\u200cخواهم soft\u00adhyphen \u0600";
  expect(terminalText(visible)).toBe(visible);
  expect(terminalText("safe\u200b\u200e\u200f\u061clabel")).toBe("safelabel");
  expect(terminalText("10%\r20%\r\n30%")).toBe("10%\n20%\n30%");
  for (let code = 0x80; code <= 0x9f; code++)
    expect(terminalText(String.fromCharCode(code))).toBe("");
  expect(
    terminalText("safe\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"),
  ).toBe("safe");
});
