import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginShell } from "../src/button/login-shell.js";
import { openLocalTerminal } from "../src/button/local-terminal.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Local terminal did not settle");
    await Bun.sleep(10);
  }
}

test("the login shell is $SHELL, else the passwd entry, else /bin/sh, each a real executable", async () => {
  expect(await loginShell({ shell: "/bin/sh", passwd: () => null })).toBe(
    "/bin/sh",
  );
  expect(
    await loginShell({ shell: "bash", passwd: () => "/usr/bin/bash" }),
  ).toBe("/usr/bin/bash");
  expect(
    await loginShell({
      shell: "/no/such/shell",
      passwd: () => "/also/missing",
    }),
  ).toBe("/bin/sh");
  expect(await loginShell({ shell: "/etc", passwd: () => null })).toBe(
    "/bin/sh",
  );
});

test("a Local terminal starts the person's $SHELL as a login shell, so their profile loads", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-login-shell-"));
  const shell = join(home, "fixture-shell");
  // A fixture login shell: bash that marks its own profile load.
  await writeFile(shell, '#!/bin/sh\nexec /usr/bin/bash "$@"\n');
  await chmod(shell, 0o755);
  await writeFile(
    join(home, ".bash_profile"),
    "export PS1='fixture> '\nprintf 'PROFILE:%s\\n' \"$0\"\n",
  );
  const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
  process.env.SHELL = shell;
  process.env.HOME = home;
  const terminal = await openLocalTerminal({ columns: 100, rows: 12 });
  const text = () =>
    terminal
      .read()
      .rows.map((row) => row.map((cell) => cell.text).join(""))
      .join("\n");
  try {
    await until(
      () => text().includes("PROFILE:") && text().includes("fixture> "),
    );
    terminal.write("printf 'SHELL:%s\\n' \"$SHELL\"\n");
    await until(() => text().includes(`SHELL:${shell}`));
  } finally {
    process.env.SHELL = saved.SHELL;
    process.env.HOME = saved.HOME;
    await terminal.close();
    await rm(home, { recursive: true, force: true });
  }
});
