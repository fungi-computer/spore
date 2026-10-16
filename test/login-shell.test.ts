import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginShell } from "../src/button/login-shell.js";
import { openLocalTerminal } from "../src/button/local-terminal.js";
import { openMacTerminal } from "../src/button/local-terminal-mac.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Local terminal did not settle");
    await Bun.sleep(10);
  }
}

test("the login shell is $SHELL, else the passwd entry, else /bin/sh, each a real executable", async () => {
  const bash = Bun.which("bash");
  if (bash === null)
    throw new Error("Bash is required for the login-shell test");
  expect(await loginShell({ shell: "/bin/sh", passwd: () => null })).toBe(
    "/bin/sh",
  );
  expect(await loginShell({ shell: "bash", passwd: () => bash })).toBe(bash);
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
  const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
  const home = await mkdtemp(join(tmpdir(), "fungi-login-shell-"));
  const shell = join(home, "fixture-shell");
  let terminal:
    | Awaited<ReturnType<typeof openLocalTerminal>>
    | Awaited<ReturnType<typeof openMacTerminal>>
    | undefined;
  let removeBytes: (() => void) | undefined;
  try {
    const bash = Bun.which("bash");
    if (bash === null)
      throw new Error("Bash is required for the login-shell test");
    // Invoke the maintained executable through the fixture path, so login
    // profiles load without assuming a platform-specific Bash location.
    await symlink(bash, shell);
    await writeFile(
      join(home, ".bash_profile"),
      "export PS1='fixture> '\nprintf 'PROFILE:%s\\n' \"$0\"\n",
    );
    process.env.SHELL = shell;
    process.env.HOME = home;
    const opened =
      process.platform === "darwin"
        ? await openMacTerminal({ columns: 100, rows: 12 })
        : await openLocalTerminal({ columns: 100, rows: 12 });
    terminal = opened;
    let rawOutput = "";
    if ("onBytes" in opened) {
      const decoder = new TextDecoder();
      removeBytes = opened.onBytes((bytes) => {
        rawOutput += decoder.decode(bytes, { stream: true });
      });
    }
    const text = () =>
      "read" in opened
        ? opened
            .read()
            .rows.map((row) => row.map((cell) => cell.text).join(""))
            .join("\n")
        : rawOutput;
    await until(
      () => text().includes("PROFILE:") && text().includes("fixture> "),
    );
    const input = "printf 'SHELL:%s\\n' \"$SHELL\"\n";
    if ("write" in opened) opened.write(input);
    else if (!opened.input(new TextEncoder().encode(input)))
      throw new Error("The login shell did not accept input");
    await until(() => text().includes(`SHELL:${shell}`));
  } finally {
    if (saved.SHELL === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved.SHELL;
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    try {
      removeBytes?.();
    } finally {
      try {
        await terminal?.close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  }
});
