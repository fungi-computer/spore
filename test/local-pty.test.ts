import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalTerminal } from "../src/button/local-terminal.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Local terminal did not settle");
    await Bun.sleep(10);
  }
}

test("a real local shell renders VT cells, resizes and interrupts its foreground job", async () => {
  const terminal = await openLocalTerminal({ columns: 80, rows: 12 });
  const text = () =>
    terminal
      .read()
      .rows.map((row) => row.map((cell) => cell.text).join(""))
      .join("\n");
  try {
    terminal.write("stty -echo; printf '\\033[2J\\033[HREADY\\n'\n");
    await until(() => text().startsWith("READY"));
    terminal.write(
      "printf '\\033]52;c;SECRET\\007\\033]0;FAKE_TITLE\\007\\033[31mVT_SAFE\\033[0m\\n'; stty size\n",
    );
    await until(() => text().includes("12 80"));
    expect(text()).toContain("VT_SAFE");
    expect(
      terminal
        .read()
        .rows.flat()
        .find((cell) => cell.text === "V")?.foreground,
    ).toBe("#cd0000");
    for (const row of terminal.read().rows)
      for (const cell of row) expect(cell.text).not.toContain("\x1b");
    expect(text()).not.toContain("FAKE_TITLE");
    terminal.resize(48, 9);
    terminal.write("stty size\n");
    await until(() => text().includes("9 48"));
    terminal.write("sleep 60\n");
    await Bun.sleep(60);
    terminal.write("\x03");
    await Bun.sleep(50);
    terminal.write("printf 'AFTER_INTERRUPT\\n'\n");
    await until(() => text().includes("AFTER_INTERRUPT"));
    expect(terminal.read().live).toBe(true);
  } finally {
    await terminal.close();
  }
  expect(terminal.read().live).toBe(false);
});

test("the shell inherits the TUI's environment, SSH agent included, minus Fungi's launcher variables", async () => {
  const saved = {
    inherited: process.env.S5_INHERITED_FIXTURE,
    agent: process.env.SSH_AUTH_SOCK,
    launcher: process.env.FUNGI_BUNDLED_CLI,
  };
  process.env.S5_INHERITED_FIXTURE = "passes";
  process.env.SSH_AUTH_SOCK = "/tmp/fixture-agent.sock";
  process.env.FUNGI_BUNDLED_CLI = "/fungi/internal/cli.js";
  const terminal = await openLocalTerminal({ columns: 100, rows: 12 });
  try {
    terminal.write(
      'printf \'ENV:%s:%s:%s:%s\\n\' "$S5_INHERITED_FIXTURE" "$SSH_AUTH_SOCK" "$FUNGI_BUNDLED_CLI" "$TERM"\n',
    );
    await until(() =>
      terminal
        .read()
        .rows.flat()
        .map((cell) => cell.text)
        .join("")
        .includes("ENV:passes:/tmp/fixture-agent.sock::xterm-256color"),
    );
  } finally {
    for (const [name, value] of [
      ["S5_INHERITED_FIXTURE", saved.inherited],
      ["SSH_AUTH_SOCK", saved.agent],
      ["FUNGI_BUNDLED_CLI", saved.launcher],
    ] as const)
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    await terminal.close();
  }
});

test("closing a shell terminates its background jobs and retires the grid subscription", async () => {
  const terminal = await openLocalTerminal({ columns: 80, rows: 12 });
  const text = () =>
    terminal
      .read()
      .rows.flat()
      .map((cell) => cell.text)
      .join("");
  let notifications = 0;
  terminal.subscribe(() => {
    notifications += 1;
  });
  try {
    terminal.write("sleep 60 & printf 'JOB:%s\\n' $!\n");
    await until(() => /JOB:[0-9]+/u.test(text()));
    const match = /JOB:([0-9]+)/u.exec(text());
    if (match?.[1] === undefined)
      throw new Error("Background job identity missing");
    await terminal.close();
    const state = Bun.spawn(["ps", "-o", "stat=", "-p", match[1]], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const status = (await new Response(state.stdout).text()).trim();
    expect(status.length === 0 || status.startsWith("Z")).toBe(true);
    const finalNotifications = notifications;
    terminal.write("printf 'LATE'\n");
    terminal.resize(100, 12);
    await Bun.sleep(20);
    expect(notifications).toBe(finalNotifications);
    expect(terminal.read().live).toBe(false);
  } finally {
    await terminal.close();
  }
});

test("a completed shell retains its exit state and cleans jobs before a later pane close", async () => {
  const terminal = await openLocalTerminal({ columns: 80, rows: 12 });
  try {
    terminal.write("exit 7\n");
    await until(() => !terminal.read().live);
    expect(terminal.read().exitCode).toBe(7);
    await terminal.close();
    await terminal.close();
  } finally {
    await terminal.close();
  }
});

test("the visible cell grid strips invisible direction marks without breaking shaping", async () => {
  const terminal = await openLocalTerminal({ columns: 100, rows: 8 });
  const text = () =>
    terminal
      .read()
      .rows.flat()
      .map((cell) => cell.text)
      .join("");
  try {
    terminal.write(
      "stty -echo; printf '\\033[2J\\033[HGRID:a\u200f\u200b\u202e\u2060b می\u200cخواهم\\n'\n",
    );
    await until(() => text().includes("GRID:"));
    expect(text()).not.toMatch(/[\u200f\u200b\u202e\u2060]/u);
    expect(text()).toContain("می\u200cخواهم");
  } finally {
    await terminal.close();
  }
});

test("paste cannot inject an early bracket end or a foreground interrupt", async () => {
  const terminal = await openLocalTerminal({ columns: 120, rows: 8 });
  const text = () =>
    terminal
      .read()
      .rows.flat()
      .map((cell) => cell.text)
      .join("");
  try {
    terminal.write(
      `stty raw -echo; python3 -u -c "import os; print('\\x1b[?2004hPASTE_'+'READY'); print('PASTE_HEX:'+os.read(0,4096).hex())"\n`,
    );
    await until(() => text().includes("PASTE_READY"));
    terminal.paste("safe\x1b[201~\x03\x1b[2Jtail");
    const expected = Buffer.from("\x1b[200~safetail\x1b[201~").toString("hex");
    await until(() => text().includes(`PASTE_HEX:${expected}`));
    expect(terminal.read().live).toBe(true);
  } finally {
    await terminal.close();
  }
});

test("closing a PTY leaves processes outside its verified OS session alive", async () => {
  const sentinel = Bun.spawn(["/usr/bin/setsid", "/bin/sleep", "60"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const terminal = await openLocalTerminal({ columns: 80, rows: 8 });
  try {
    await terminal.close();
    const state = Bun.spawn(
      ["/usr/bin/ps", "-o", "stat=", "-p", String(sentinel.pid)],
      { stdout: "pipe", stderr: "pipe" },
    );
    const status = (await new Response(state.stdout).text()).trim();
    expect(status.length > 0 && !status.startsWith("Z")).toBe(true);
  } finally {
    await terminal.close();
    sentinel.kill("SIGKILL");
    await sentinel.exited;
  }
});

test("PTY lifecycle utilities ignore executables planted in the caller PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tui-untrusted-path-"));
  const marker = join(directory, "executed");
  const originalPath = process.env.PATH;
  try {
    for (const utility of ["setsid", "ps", "pkill"])
      await writeFile(
        join(directory, utility),
        `#!/bin/sh\nprintf unsafe >> '${marker}'\nexit 99\n`,
        { mode: 0o700 },
      );
    process.env.PATH = `${directory}:${originalPath ?? "/usr/bin:/bin"}`;
    const terminal = await openLocalTerminal({ columns: 80, rows: 8 });
    try {
      expect(await terminal.hasRunningJobs()).toBe(false);
    } finally {
      await terminal.close();
    }
    const result = await readFile(marker, "utf8").catch(
      (cause: unknown) => cause,
    );
    expect(result).toMatchObject({ code: "ENOENT" });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});
