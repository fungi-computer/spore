// Pre-install interactive smoke: the real launcher in a real PTY, driven by
// keystrokes the way a person uses it. Frame tests render React trees; this
// proof types into a freshly opened pane and reads the emulated screen.
//
// Usage: bun test/interactive-smoke.proof.mjs [launcher]
//   launcher: a packaged `dist/fungi.cjs`, or a `cli.js` run by this Bun.
//   Omitted: build this checkout's TUI and run its `dist/cli.js`.
// Run it under the bounded runner (`pnpm --dir apps/tui proof:interactive`).
// Each variant owns a temp HOME, a synthetic project and its own Local
// service; nothing reads or writes the real ~/.fungi or a user's pane.
import { Terminal as Emulator } from "@xterm/headless";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
import process from "node:process";
import { serve, sleep, spawn, Terminal } from "bun";

const columns = 120;
const rows = 36;
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repository = resolve(packageRoot, "../..");
const pickerFooter = "↑↓ choose · Enter select · Esc cancel";
const composerPlaceholder = "Ask anything";
const terminalPrompt = "smoke-terminal> ";
const keys = {
  leader: "\x0b",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  interrupt: "\x03",
};

async function run(command, cwd) {
  const child = spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new globalThis.Response(child.stdout).text(),
    new globalThis.Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`${command.join(" ")} failed:\n${stdout}${stderr}`);
}

/** Build this checkout first (turbo-cached); the fixture reads its schema. */
async function launcherCommand() {
  await run(
    ["pnpm", "turbo:run", "run", "build", "--filter=@fungi.computer/spore"],
    repository,
  );
  const supplied = process.argv.slice(2).find((value) => value !== "--");
  if (supplied === undefined)
    return [process.execPath, join(packageRoot, "dist/cli.js")];
  const path = resolve(supplied);
  return path.endsWith(".js") ? [process.execPath, path] : [path];
}

/** A loopback stand-in for the Hub's Team App directory; no real account. */
function startFixtureHub(appDirectoryResponseSchema) {
  // Parsed by the same strict schema the Local client reads the Hub with, so
  // a contract change fails here by name instead of as a smoke regression.
  const directory = appDirectoryResponseSchema.parse({
    actorIsTeamOwner: false,
    roles: {},
    apps: [
      {
        address: { kind: "default", appId: "smoke-app" },
        appId: "smoke-app",
        displayName: "Smoke Fixture App",
        installationId: null,
        surfaceId: "default:smoke-app",
        releaseId: "release-smoke",
        override: null,
        authorityVersion: 1,
        enforcement: null,
        grants: [],
        generationPermissions: { llm: false, media: false },
        marketplacePermissions: {
          browse: false,
          purchase: false,
          installFree: false,
        },
        // The Hub's noAppAgentPermission: an installed App with no Agent grant.
        agentPermission: {
          kind: "all-team-agents",
          directoryOperations: [],
          sessionOperations: [],
        },
        handlers: [],
        roles: [],
        declaredCapabilities: [],
        commands: [],
        gills: [],
        availability: "available",
        surface: { stableRoute: "/ui" },
        surfacePath: "/apps/default/smoke-app/ui",
      },
    ],
  });
  const requests = [];
  let directoryReads = 0;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path !== "/api/teams/team_smoke/local/apps")
        return new globalThis.Response("not in the smoke fixture", {
          status: 404,
        });
      directoryReads += 1;
      // The first read fails, so a refused choice is exercised signed in.
      return directoryReads === 1
        ? new globalThis.Response("fixture outage", { status: 503 })
        : globalThis.Response.json(directory);
    },
  });
  return { server, requests, origin: `http://127.0.0.1:${server.port}` };
}

async function prepareVariant(root, variant, hubOrigin) {
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  const project = join(root, "synthetic");
  await mkdir(join(home, ".fungi"), { recursive: true, mode: 0o700 });
  await mkdir(runtime, { mode: 0o700 });
  await chmod(runtime, 0o700);
  await mkdir(project, { mode: 0o700 });
  await writeFile(join(project, "README.md"), "Synthetic smoke project.\n");
  // Observe the real shell without depending on removed pane status chrome.
  await writeFile(
    join(home, ".profile"),
    `PS1='${terminalPrompt}'; export PS1\n`,
    { mode: 0o600 },
  );
  // A person who already finished onboarding, as on an installed machine.
  await writeFile(
    join(home, ".fungi/onboarding.json"),
    `${JSON.stringify({ version: 1, door: "later" })}\n`,
    { mode: 0o600 },
  );
  if (variant === "signed-in") {
    const directory = join(home, ".config/fungi");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const credentials = join(directory, "credentials.json");
    await writeFile(
      credentials,
      JSON.stringify({
        fungi: {
          type: "oauth",
          access: "smoke-fixture-access",
          refresh: "smoke-fixture-refresh",
          expires: Date.now() + 60 * 60 * 1000,
          issuer: hubOrigin,
          team: {
            teamId: "team_smoke",
            handle: "smoke",
            name: "Smoke Team",
          },
          teamCount: 1,
        },
      }),
      { mode: 0o600 },
    );
    await chmod(credentials, 0o600);
  }
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_RUNTIME_DIR: runtime,
    TERM: "xterm-256color",
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
  };
  return { home, project, env };
}

function createScreen() {
  const emulator = new Emulator({
    cols: columns,
    rows,
    scrollback: 0,
    allowProposedApi: true,
  });
  const lines = () =>
    Array.from(
      { length: rows },
      (_, row) =>
        emulator.buffer.active.getLine(row)?.translateToString(true) ?? "",
    );
  return { emulator, lines, text: () => lines().join("\n") };
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

/** Rows of the open choice picker, located by its footer column. */
function pickerRows(lines) {
  const footer = lines.findIndex((line) => line.includes(pickerFooter));
  if (footer < 0) return undefined;
  const column = lines[footer].indexOf(pickerFooter);
  const choices = [];
  for (let index = footer - 1; index >= 0; index -= 1) {
    const cell = lines[index].slice(column);
    if (cell.trim() === "") continue;
    if (cell.trim() === "/ type to filter") continue;
    const match = /^(?:[1-9] | {2})(▶ | {2})(\S.*?)(?: {2,}|$)/u.exec(cell);
    if (match === null) {
      return { title: cell.trim(), choices: choices.reverse() };
    }
    choices.push({ name: match[2].trim(), selected: match[1] === "▶ " });
  }
  return { title: "", choices: choices.reverse() };
}

async function runVariant(command, variant, appDirectoryResponseSchema) {
  const root = await mkdtemp(join(tmpdir(), `fungi-interactive-${variant}-`));
  const hub =
    variant === "signed-in"
      ? startFixtureHub(appDirectoryResponseSchema)
      : undefined;
  const { project, env } = await prepareVariant(root, variant, hub?.origin);
  const screen = createScreen();
  const terminal = new Terminal({
    cols: columns,
    rows,
    data: (_terminal, bytes) => {
      screen.emulator.write(bytes);
    },
  });
  const results = [];
  const child = spawn(command, { cwd: project, env, terminal });
  const exited = () => child.exitCode !== null;

  const type = async (input) => {
    terminal.write(input);
    // A bare Esc followed too soon by another key decodes as Alt+key.
    await sleep(input === keys.escape ? 400 : 120);
  };
  const waitFor = async (predicate, timeout = 5_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !exited()) {
      if (predicate(screen.text(), screen.lines())) return true;
      await sleep(50);
    }
    return predicate(screen.text(), screen.lines());
  };
  const expect = async (predicate, message, timeout) => {
    if (!(await waitFor(predicate, timeout)))
      throw new Error(`${message}\n${screen.text()}`);
  };
  const leaderShown = (text) =>
    text.includes("Close pane") &&
    text.includes("All commands") &&
    !text.includes(pickerFooter);
  /** Ctrl K then a key; true once the nonmodal hints gave way to its action. */
  const leader = async (key) => {
    await type(keys.leader);
    await expect(leaderShown, "Ctrl K did not show the which-key hints");
    await type(key);
    return waitFor((text, lines) => !leaderShown(text, lines), 1_500);
  };
  /** Move the highlight onto a choice, confirm it is there, then Enter. */
  const choose = async (name) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const picker = pickerRows(screen.lines());
      const target =
        picker?.choices.findIndex((row) => row.name === name) ?? -1;
      const current = picker?.choices.findIndex((row) => row.selected) ?? -1;
      if (target < 0 || current < 0)
        throw new Error(`The open picker has no choice "${name}"`);
      if (target === current) {
        await type(keys.enter);
        return;
      }
      const move = target > current ? keys.down : keys.up;
      for (let index = 0; index < Math.abs(target - current); index += 1)
        await type(move);
      await sleep(150);
    }
    throw new Error(`The picker highlight never reached "${name}"`);
  };

  const erase = async (count) => {
    for (let index = 0; index < count; index += 1) await type(keys.backspace);
  };
  const slashMenuShown = (text) => /\/help\s+Show commands/u.test(text);
  const assertSlashMenu = async () => {
    await type("/");
    const shown = await waitFor(slashMenuShown, 3_000);
    const frame = screen.text();
    await erase(1);
    if (!shown)
      throw new Error(
        `Typing "/" in the conversation did not open the slash menu:\n${frame}`,
      );
  };
  const closeQuestion = "Close local shell and terminate its jobs?";
  /** An idle shell closes at once: no termination question. */
  const closeFocusedTerminal = async () => {
    await leader("x");
    const closed = await waitFor(
      (text) => !text.includes(terminalPrompt),
      3_000,
    );
    if (screen.text().includes(closeQuestion)) {
      await choose("Terminate and close");
      throw new Error(
        `Ctrl K x on an idle terminal asked "${closeQuestion}" instead of closing at once`,
      );
    }
    if (!closed)
      throw new Error("Ctrl K x on an idle terminal did not close it");
  };
  const terminalOpen = (text) => text.includes(terminalPrompt);
  /** The shell runs the command; the conversation composer never sees it. */
  const assertTerminalTakesTyping = async (sum) => {
    const typed = `echo smoke-$((40+${String(sum - 40)}))`;
    await type(`${typed}${keys.enter}`);
    const echoed = await waitFor(
      (text) => text.includes(`smoke-${String(sum)}`),
      5_000,
    );
    const text = screen.text();
    if (occurrences(text, typed) > 1 || !text.includes(composerPlaceholder))
      throw new Error(
        "Keys typed into the terminal also reached the conversation composer",
      );
    if (!echoed)
      throw new Error(
        `The terminal never showed "smoke-${String(sum)}" after echo + Enter: it takes no typing`,
      );
  };
  const step = async (name, body) => {
    try {
      await body();
      results.push({ variant, name, ok: true });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      results.push({ variant, name, ok: false, reason, screen: screen.text() });
      // Leave any open picker, then continue so one red run names every break.
      for (let index = 0; index < 3; index += 1) {
        if (pickerRows(screen.lines()) === undefined) break;
        await type(keys.escape);
      }
    }
  };

  const expected = [
    "Local terminal",
    "New conversation",
    "Resume conversation",
    ...(variant === "signed-in" ? ["Apps"] : []),
  ];
  const pickerOpen = (_text, lines) => {
    const picker = pickerRows(lines);
    return picker !== undefined && picker.title !== "Panes";
  };
  /** Ctrl K o: the one Open pane picker. */
  const openPicker = async () => {
    if (!(await leader("o")))
      throw new Error("Ctrl K o did not open a pane picker");
    await expect(pickerOpen, "No pane picker opened");
  };
  const openChoice = async (name) => {
    await openPicker();
    await choose(name);
  };

  try {
    const bootDeadline = Date.now() + 60_000;
    await expect(
      (text) =>
        text.includes("No conversations in this folder yet") &&
        text.includes("+ New session"),
      "The new-project landing never rendered",
      Math.max(0, bootDeadline - Date.now()),
    );
    await type("n");
    await expect(
      (text) => text.includes(composerPlaceholder),
      "The conversation composer never rendered",
      Math.max(0, bootDeadline - Date.now()),
    );

    await step('(a) "/" opens the slash menu', assertSlashMenu);

    await step(
      "(b) an unmatched leader key leaves the composer focused and unchanged",
      async () => {
        const draft = "leader-discard-draft";
        await type(draft);
        await expect(
          (text) => text.includes(draft),
          "Draft did not reach the composer",
        );
        // z is the real Zoom binding; q is unbound in this shipped shell.
        // The decoded-key fixture separately proves an unmatched Ctrl-K,z.
        await type(keys.leader);
        await type("q");
        await type("!");
        await expect(
          (text) => text.includes(`${draft}!`),
          "The unmatched follow-up changed the draft or stole composer focus",
        );
        if (screen.text().includes(`${draft}q`))
          throw new Error("The unmatched leader key reached the composer");
        await erase(draft.length + 1);
        await expect(
          (text) => text.includes(composerPlaceholder),
          "The composer did not remain editable after discarding the follow-up",
        );
      },
    );

    let listed = [];
    await step(
      `(c) Ctrl K o lists exactly: ${expected.join(", ")}`,
      async () => {
        if (!(await leader("o"))) {
          await type(keys.escape);
          throw new Error(
            "Ctrl K o is not a pane key; the Panes keys stayed open",
          );
        }
        await expect(pickerOpen, "Ctrl K o showed no pane picker");
        const picker = pickerRows(screen.lines());
        await type(keys.escape);
        const names = picker?.choices.map((row) => row.name) ?? [];
        const missing = expected.filter((name) => !names.includes(name));
        const extra = names.filter((name) => !expected.includes(name));
        if (missing.length > 0 || extra.length > 0)
          throw new Error(
            `Picker listed [${names.join(", ")}]; missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]`,
          );
      },
    );

    await step("(c) read every choice the pane picker shows", async () => {
      await openPicker();
      listed = pickerRows(screen.lines())?.choices.map((row) => row.name) ?? [];
      if (listed.length === 0)
        throw new Error("The open pane picker listed no choices");
      await type(keys.escape);
      // A failing App read goes first: that is how Levi's install broke.
      listed.sort(
        (left, right) => Number(right === "Apps") - Number(left === "Apps"),
      );
    });

    for (const name of listed) {
      if (name === "Apps") {
        const reason =
          variant === "signed-in"
            ? "App directory refused with HTTP 503"
            : "Sign in to Fungi";
        await step(
          `(c) Apps: a refused choice shows "${reason}" until Escape dismisses it`,
          async () => {
            await openChoice("Apps");
            await expect(
              (text) => text.includes(reason),
              `Choosing Apps showed no "${reason}" notice: a silent no-op`,
            );
            // Attention survives ordinary keys; Escape dismisses only the toast.
            await type(keys.down);
            if (!screen.text().includes(reason))
              throw new Error("An ordinary key dismissed the attention toast");
            await type(keys.escape);
            await expect(
              (text) => !text.includes(reason),
              "The refused-choice notice stayed after Escape",
              2_000,
            );
          },
        );
        await step(
          '(c) Apps: after the refused choice, "/" opens the slash menu',
          assertSlashMenu,
        );
        if (variant === "signed-in")
          await step("(c) Apps: the Team's App list opens", async () => {
            await openChoice("Apps");
            await expect(
              (text) => text.includes("Smoke Fixture App"),
              "Choosing Apps did not list the fixture Team's App",
            );
            await type(keys.escape);
          });
      } else if (name === "Local terminal") {
        await step(
          "(c) Local terminal: opens a shell that takes typing",
          async () => {
            await openChoice("Local terminal");
            await expect(
              terminalOpen,
              "Choosing Local terminal opened no terminal pane",
            );
            await assertTerminalTakesTyping(43);
            await closeFocusedTerminal();
          },
        );
      } else if (name === "New conversation") {
        await step(
          "(c) New conversation: a focused second pane alone takes typing",
          async () => {
            await openChoice("New conversation");
            await expect(
              (text) => occurrences(text, composerPlaceholder) === 2,
              "Choosing New conversation did not open a second conversation pane",
            );
            const marker = "smoke-second-pane";
            await type(marker);
            await waitFor((text) => text.includes(marker), 3_000);
            const row = screen.lines().find((line) => line.includes(marker));
            const text = screen.text();
            await erase(marker.length);
            if (
              row === undefined ||
              occurrences(text, marker) !== 1 ||
              occurrences(text, composerPlaceholder) !== 1 ||
              row.indexOf(marker) < columns / 3
            )
              throw new Error(
                "Typing after New conversation did not land only in the new, focused pane",
              );
            await leader("x");
            await expect(
              (now) =>
                occurrences(now, composerPlaceholder) === 1 &&
                pickerRows(screen.lines()) === undefined,
              "Ctrl K x did not close the second conversation pane",
            );
          },
        );
      } else {
        await step(
          `(c) ${name}: opens something, not a silent no-op`,
          async () => {
            const before = screen.text();
            await openChoice(name);
            await expect(
              (text) =>
                text !== before &&
                pickerRows(screen.lines())?.title !== "Open pane",
              `Choosing ${name} changed nothing on screen`,
            );
            for (let index = 0; index < 3; index += 1) {
              if (pickerRows(screen.lines()) === undefined) break;
              await type(keys.escape);
            }
          },
        );
      }
    }

    await step(
      "(b) Ctrl K o then Enter opens the listed Local terminal",
      async () => {
        const before = occurrences(screen.text(), terminalPrompt);
        await openChoice("Local terminal");
        await expect(
          (text) => occurrences(text, terminalPrompt) > before,
          "Choosing Local terminal from Ctrl K o did not open a terminal pane",
        );
      },
    );

    await step(
      "(b) echo in the terminal shows its output; keys stay out of the composer",
      () => assertTerminalTakesTyping(42),
    );

    await step(
      "(d) Ctrl K x closes the terminal; typing reaches the conversation again",
      async () => {
        if (terminalOpen(screen.text())) await closeFocusedTerminal();
        const marker = "smoke-after-close";
        await type(marker);
        const typed = await waitFor(
          (_text, lines) => lines.some((line) => line.includes(`› ${marker}`)),
          3_000,
        );
        await erase(marker.length);
        if (!typed)
          throw new Error(
            "After closing the terminal, typing did not reach the conversation composer",
          );
      },
    );

    await step(
      "(d) a terminal with a running job asks before Ctrl K x terminates it",
      async () => {
        const before = occurrences(screen.text(), terminalPrompt);
        await openChoice("Local terminal");
        await expect(
          (text) => occurrences(text, terminalPrompt) > before,
          "Ctrl K o did not open a Local terminal pane",
        );
        await type(`sleep 30 &${keys.enter}`);
        await sleep(500);
        await leader("x");
        await expect(
          (text) => text.includes(closeQuestion),
          `Ctrl K x with a running job did not ask "${closeQuestion}"`,
        );
        await choose("Keep local shell open");
        await expect(
          (text) => !text.includes(closeQuestion) && terminalOpen(text),
          "Keep local shell open did not keep the terminal",
        );
        await leader("x");
        await expect(
          (text) => text.includes(closeQuestion),
          "The second Ctrl K x with a running job did not ask again",
        );
        await choose("Terminate and close");
        await expect(
          (text) => !text.includes(terminalPrompt),
          "The terminal pane is still shown after Terminate and close",
        );
      },
    );

    await step(
      '(a) "/" still opens the slash menu at the end',
      assertSlashMenu,
    );
  } finally {
    // Quit the TUI, then stop this variant's own Local service.
    await type(keys.interrupt);
    await Promise.race([child.exited, sleep(1_500)]);
    if (!exited()) {
      await type(keys.interrupt);
      await Promise.race([child.exited, sleep(1_500)]);
    }
    if (!exited()) child.kill();
    terminal.close();
    screen.emulator.dispose();
    const stop = spawn([...command, "stop"], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stopCode = await stop.exited;
    if (stopCode !== 0)
      results.push({
        variant,
        name: "own Local service stops",
        ok: false,
        reason: `stop exited ${String(stopCode)}: ${await new globalThis.Response(stop.stderr).text()}`,
      });
    if (hub !== undefined) {
      await hub.server.stop(true);
      const unexpected = hub.requests.filter(
        (line) => !line.endsWith("/api/teams/team_smoke/local/apps"),
      );
      if (unexpected.length > 0)
        console.log(
          `[${variant}] fixture Hub also saw: ${unexpected.join(", ")}`,
        );
    }
    await rm(root, { recursive: true, force: true });
  }
  return results;
}

const command = await launcherCommand();
// Imported after the build: a fresh checkout has no Oyster dist before it.
const { appDirectoryResponseSchema } =
  await import("@fungi.computer/nacre/app-directory");
const results = [
  ...(await runVariant(command, "signed-out", appDirectoryResponseSchema)),
  ...(await runVariant(command, "signed-in", appDirectoryResponseSchema)),
];
for (const result of results)
  console.log(
    `${result.ok ? "PASS" : "FAIL"} [${result.variant}] ${result.name}${result.ok ? "" : ` — ${result.reason}`}`,
  );
const failures = results.filter((result) => !result.ok);
for (const failure of failures)
  if (failure.screen !== undefined)
    console.log(
      `\n--- screen at FAIL [${failure.variant}] ${failure.name}\n${failure.screen.replace(/\s+$/gmu, "")}`,
    );
console.log(
  `TUI interactive smoke ${failures.length === 0 ? "PASS" : "FAIL"}: ${String(results.length - failures.length)}/${String(results.length)} (${command.join(" ")}; temp HOME, own Local service, no real account)`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
