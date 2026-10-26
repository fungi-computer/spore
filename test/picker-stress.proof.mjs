// The real launcher in a real PTY: open the Ctrl K o pane picker 20 times
// and require each one to move its highlight on the first Down. A picker that
// stops taking keys (a stale focus effect stealing its input) fails here.
//
// Usage: bun test/picker-stress.proof.mjs <launcher> [opens]
//   launcher: a packaged `dist/fungi.cjs`, or a `cli.js` run by this Bun.
// Signed out, temp HOME, its own Local service; nothing reads the real ~/.fungi.
import { Terminal as Emulator } from "@xterm/headless";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import console from "node:console";
import process from "node:process";
import { sleep, spawn, Terminal } from "bun";

const [launcherArgument, opensArgument] = process.argv
  .slice(2)
  .filter((value) => value !== "--");
if (launcherArgument === undefined)
  throw new Error("Usage: picker-stress.proof.mjs <launcher> [opens]");
const launcher = resolve(launcherArgument);
const command = launcher.endsWith(".cjs")
  ? ["node", launcher]
  : [process.execPath, launcher];
const opens = Number(opensArgument ?? 20);
const columns = 120;
const rows = 36;
const keys = { leader: "\x0b", escape: "\x1b", down: "\x1b[B" };

const root = await mkdtemp(join(tmpdir(), "fungi-picker-stress-"));
const home = join(root, "home");
const runtime = join(root, "runtime");
const project = join(root, "synthetic");
await mkdir(join(home, ".fungi"), { recursive: true, mode: 0o700 });
await mkdir(runtime, { mode: 0o700 });
await chmod(runtime, 0o700);
await mkdir(project, { mode: 0o700 });
await writeFile(
  join(home, ".fungi/onboarding.json"),
  `${JSON.stringify({ version: 1, door: "later" })}\n`,
  { mode: 0o600 },
);
const emulator = new Emulator({
  cols: columns,
  rows,
  scrollback: 0,
  allowProposedApi: true,
});
const text = () =>
  Array.from(
    { length: rows },
    (_, row) =>
      emulator.buffer.active.getLine(row)?.translateToString(true) ?? "",
  ).join("\n");
const terminal = new Terminal({
  cols: columns,
  rows,
  data: (_terminal, bytes) => {
    emulator.write(bytes);
  },
});
const child = spawn(command, {
  cwd: project,
  terminal,
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_RUNTIME_DIR: runtime,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  },
});
const waitFor = async (predicate, timeout) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(text())) return true;
    await sleep(25);
  }
  return predicate(text());
};
const stalls = [];
try {
  if (!(await waitFor((screen) => screen.includes("Ask anything"), 60_000)))
    throw new Error("The conversation never rendered");
  for (let open = 0; open < opens; open += 1) {
    terminal.write(keys.leader);
    if (!(await waitFor((screen) => screen.includes("Open pane"), 5_000)))
      throw new Error(`Open ${String(open)}: Ctrl K showed no Panes keys`);
    terminal.write("o");
    if (
      !(await waitFor((screen) => screen.includes("▶ Local terminal"), 5_000))
    )
      throw new Error(`Open ${String(open)}: Ctrl K o showed no picker`);
    terminal.write(keys.down);
    if (!(await waitFor((screen) => /▶ New conversation/u.test(screen), 2_000)))
      stalls.push(open);
    terminal.write(keys.escape);
    await waitFor((screen) => !screen.includes("Local terminal"), 5_000);
    // A bare Esc followed too soon by another key decodes as Alt+key.
    await sleep(400);
  }
} finally {
  child.kill();
  await child.exited;
  terminal.close();
  await rm(root, { recursive: true, force: true });
}
console.log(
  `Picker stress ${stalls.length === 0 ? "PASS" : "FAIL"}: ${String(opens - stalls.length)}/${String(opens)} pickers took Down${stalls.length === 0 ? "" : `; stalled opens ${stalls.join(", ")}`}`,
);
process.exitCode = stalls.length === 0 ? 0 : 1;
