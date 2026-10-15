import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import console from "node:console";
import { execFileSync } from "node:child_process";
import process from "node:process";

const home = await mkdtemp(join(tmpdir(), "fungi-terminal-sanitize-"));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const installed = process.argv[2];
const fixture = fileURLToPath(
  new URL("./terminal-text-pty.fixture.mjs", import.meta.url),
);
const command =
  "stty cols 160 rows 48; " +
  ["bun", fixture, ...(installed === undefined ? [] : [installed])]
    .map(quote)
    .join(" ");
try {
  const transcript = join(home, "terminal.log");
  execFileSync("script", ["-q", "-e", "-c", command, transcript], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TERM: "xterm-256color",
      COLUMNS: "160",
      LINES: "48",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  const bytes = await readFile(transcript);
  const output = bytes.toString("utf8");
  for (const forbidden of [
    "SANITIZER_TITLE",
    "U0FOSVRJWkVSX0NMSVBCT0FSRA==",
    "https://sanitizer-invalid.test/spoof",
  ])
    assert.ok(
      !output.includes(forbidden),
      `attacker terminal program reached PTY: ${forbidden}`,
    );
  for (const marker of [
    "USER_SAFE",
    "END_USER",
    "PROSE_SAFE",
    "END_PROSE",
    "CODE_SAFE",
    "END_CODE",
    "SANITIZER_PTY_COMPLETE",
  ])
    assert.ok(
      output.includes(marker),
      `real terminal did not render ${marker}`,
    );
  assert.ok(
    !output.includes("\u001b]52;"),
    "OSC clipboard program reached the terminal",
  );
  assert.ok(
    !output.includes(String.fromCharCode(0x9b)),
    "C1 CSI reached the terminal",
  );
  assert.ok(
    !output.includes(String.fromCharCode(0x202e)),
    "bidi override reached the terminal",
  );
  // Native painting legitimately emits CSI. Raw text buffers are independently
  // checked for all controls by the native renderer unit probes.
  console.log(
    `Terminal sanitizer real-PTY PASS (${installed ?? "source public CLI"}; isolated HOME; no model/login)`,
  );
} finally {
  await rm(home, { recursive: true, force: true });
}
