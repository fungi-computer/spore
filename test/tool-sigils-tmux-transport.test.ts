import { expect, test } from "bun:test";
import { wrapForTmuxPassthrough } from "../src/tool-sigils.js";

test("wraps one complete escape sequence in tmux's DCS passthrough framing", () => {
  const sequence = "\u001b_Ga=t,f=100,i=61441,q=2,m=0;AAAA\u001b\\";
  expect(wrapForTmuxPassthrough(sequence)).toBe(
    `\u001bPtmux;${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`,
  );
});

test("matches the exact byte shape OpenTUI's native wrapForTmux produces", () => {
  // packages/native/src/ansi.zig: tmuxDcsStart ++ <ESC doubled> ++ tmuxDcsEnd.
  const sequence = "\u001b_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA\u001b\\";
  const wrapped = wrapForTmuxPassthrough(sequence);
  expect(wrapped.startsWith("\u001bPtmux;")).toBe(true);
  expect(wrapped.endsWith("\u001b\\")).toBe(true);
  const inner = wrapped.slice("\u001bPtmux;".length, -"\u001b\\".length);
  expect(inner).toBe(sequence.replaceAll("\u001b", "\u001b\u001b"));
  // Doubling every ESC, then unwrapping (removing the outer frame and
  // un-doubling), must recover the original sequence exactly.
  expect(inner.replaceAll("\u001b\u001b", "\u001b")).toBe(sequence);
});

test("doubles every ESC byte in a multi-escape sequence, not just the first", () => {
  const sequence = "\u001b_Ga=d,d=I,i=61441,q=2;\u001b\\";
  const escCount = sequence.split("\u001b").length - 1;
  const wrapped = wrapForTmuxPassthrough(sequence);
  const inner = wrapped.slice("\u001bPtmux;".length, -"\u001b\\".length);
  expect(inner.split("\u001b").length - 1).toBe(escCount * 2);
});

test("a sequence with no ESC bytes still gets the tmux frame once", () => {
  expect(wrapForTmuxPassthrough("plain")).toBe("\u001bPtmux;plain\u001b\\");
});
