import { expect, test } from "bun:test";
import process from "node:process";
import { Writable } from "node:stream";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { openTerminalApplication } from "../dist/terminal-application.js";

class RecordedTerminal extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  output = "";
  _write(chunk, _encoding, callback) {
    this.output += chunk.toString();
    callback();
  }
  getColorDepth() {
    return 24;
  }
}

for (const [
  title,
  mode,
  terminal,
  reply,
  enabled,
  environmentOff,
  herdrEnvironment,
] of [
  ["off overrides a successful probe", "off", "kitty", "supported", false],
  ["auto refuses an unsupported probe", "auto", "kitty", "unsupported", false],
  ["auto refuses a timed-out probe", "auto", "kitty", "timeout", false],
  ["auto admits kitty", "auto", "kitty", "supported", true],
  ["auto admits Ghostty", "auto", "ghostty", "supported", true],
  ["auto admits verified Herdr", "auto", "herdr", "supported", true],
  [
    "auto refuses HERDR_ENV=0 under WezTerm",
    "auto",
    "WezTerm",
    "supported",
    false,
    false,
    "0",
  ],
  [
    "auto refuses HERDR_ENV=01 under WezTerm",
    "auto",
    "WezTerm",
    "supported",
    false,
    false,
    "01",
  ],
  [
    "auto refuses WezTerm despite graphics support",
    "auto",
    "WezTerm",
    "supported",
    false,
  ],
  [
    "auto refuses Konsole despite graphics support",
    "auto",
    "Konsole",
    "supported",
    false,
  ],
  ["force on bypasses identity", "on", "WezTerm", "supported", true],
  [
    "environment off overrides force on",
    "on",
    "kitty",
    "supported",
    false,
    true,
  ],
  ["auto admits Ghostty TERM", "auto", "xterm-ghostty", "supported", true],
  ["auto admits kitty TERM", "auto", "xterm-kitty", "supported", true],
  [
    "force on still requires a positive probe",
    "on",
    "WezTerm",
    "unsupported",
    false,
  ],
  // tmux masks TERM/TERM_PROGRAM with its own identity, so admission comes
  // from the renderer's own multiplexer capability, not those two checks.
  [
    "auto refuses tmux without a positive probe",
    "auto",
    "tmux",
    "unsupported",
    false,
  ],
  [
    "auto refuses a timed-out probe under tmux",
    "auto",
    "tmux",
    "timeout",
    false,
  ],
  [
    "auto admits tmux after a positive probe",
    "auto",
    "tmux",
    "supported",
    true,
  ],
  [
    "force on under tmux still requires a positive probe",
    "on",
    "tmux",
    "unsupported",
    false,
  ],
  [
    "force on under tmux wraps transport once admitted",
    "on",
    "tmux",
    "supported",
    true,
  ],
]) {
  test(`terminal sigils: ${title}`, async () => {
    const previous = {
      TERM: process.env.TERM,
      TERM_PROGRAM: process.env.TERM_PROGRAM,
      TMUX: process.env.TMUX,
      HERDR_ENV: process.env.HERDR_ENV,
      FUNGI_TUI_SIGILS: process.env.FUNGI_TUI_SIGILS,
    };
    const insideTmux = terminal === "tmux";
    if (insideTmux) {
      // tmux overwrites both TERM and TERM_PROGRAM for its attached client
      // (observed: TERM=tmux-256color, TERM_PROGRAM=tmux), masking whatever
      // the real outer terminal reports. Recognition must not rely on either.
      process.env.TERM = "tmux-256color";
      process.env.TERM_PROGRAM = "tmux";
      process.env.TMUX = "/tmp/tmux-fake,1,0";
    } else {
      process.env.TERM = terminal.startsWith("xterm-")
        ? terminal
        : "xterm-256color";
      process.env.TERM_PROGRAM = [
        "herdr",
        "xterm-kitty",
        "xterm-ghostty",
      ].includes(terminal)
        ? ""
        : terminal;
      delete process.env.TMUX;
    }
    if (environmentOff) process.env.FUNGI_TUI_SIGILS = "off";
    else delete process.env.FUNGI_TUI_SIGILS;
    if (herdrEnvironment !== undefined)
      process.env.HERDR_ENV = herdrEnvironment;
    else if (terminal === "herdr") process.env.HERDR_ENV = "1";
    else delete process.env.HERDR_ENV;
    const stdout = new RecordedTerminal();
    let setup;
    let app;
    try {
      app = await openTerminalApplication({
        signals: { on: () => undefined, off: () => undefined },
        probeSigils: true,
        enableKeymap: false,
        createQueryClient,
        createWhistle,
        createRoot,
        createRenderer: async (config) => {
          setup = await createTestRenderer({
            ...config,
            stdout,
            bufferedOutput: "stdout",
            width: 80,
            height: 24,
          });
          for (const observe of config.prependInputHandlers ?? []) {
            if (reply === "supported") observe("\u001b_Gi=31337;OK\u001b\\");
            if (reply !== "timeout") observe("\u001b[?62;22c");
          }
          return setup.renderer;
        },
      });
      if (!app || !setup) throw new Error("Terminal did not open");
      expect((await app.loadToolSigils(mode)) !== undefined).toBe(enabled);
      await setup.renderOnce();
      await setup.renderer.idle();
      await app.close();
      const graphics = stdout.output.split("\u001b_G").slice(1);
      if (!enabled) expect(graphics).toEqual([]);
      expect(
        graphics.filter((sequence) => sequence.includes("a=t,")),
      ).toHaveLength(enabled ? 8 : 0);
      expect(
        graphics.filter((sequence) => sequence.includes("a=p,")),
      ).toHaveLength(enabled ? 8 : 0);
      // Direct Ghostty/Kitty/herdr stay byte-identical: no tmux DCS framing
      // ever appears outside tmux. Inside tmux, every transmitted sequence
      // carries it so tmux forwards the bytes instead of swallowing them.
      expect(stdout.output.includes("\u001bPtmux;")).toBe(
        insideTmux && enabled,
      );
    } finally {
      await app?.close();
      if (previous.TERM === undefined) delete process.env.TERM;
      else process.env.TERM = previous.TERM;
      if (previous.TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM;
      else process.env.TERM_PROGRAM = previous.TERM_PROGRAM;
      if (previous.TMUX === undefined) delete process.env.TMUX;
      else process.env.TMUX = previous.TMUX;
      if (previous.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = previous.HERDR_ENV;
      if (previous.FUNGI_TUI_SIGILS === undefined)
        delete process.env.FUNGI_TUI_SIGILS;
      else process.env.FUNGI_TUI_SIGILS = previous.FUNGI_TUI_SIGILS;
    }
  });
}
