import { strict as assert } from "node:assert";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import {
  loadThemePreference,
  saveThemePreference,
} from "../src/button/theme-preferences.js";

test("the update policy survives theme changes and rejects unsupported modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-update-policy-"));
  const path = join(directory, "tui.json");
  try {
    await writeFile(path, '{"update":"off"}');
    assert.equal((await loadThemePreference(path)).update, "off");
    await saveThemePreference("latte", path);
    assert.equal((await loadThemePreference(path)).update, "off");
    await writeFile(path, '{"update":"auto"}');
    assert.match(
      (await loadThemePreference(path)).error ?? "",
      /update off or notify/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("theme choices replace a complete file atomically and survive reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-theme-"));
  const path = join(directory, "preferences", "tui.json");
  try {
    assert.deepEqual(await loadThemePreference(path), { theme: "terminal" });
    await saveThemePreference("latte", path);
    const before = await stat(path);
    assert.equal(before.mode & 0o777, 0o600);
    assert.deepEqual(await loadThemePreference(path), { theme: "latte" });
    await saveThemePreference("mocha", path);
    assert.notEqual(
      (await stat(path)).ino,
      before.ino,
      "save replaces the inode",
    );
    assert.equal(await readFile(path, "utf8"), '{"theme":"mocha"}\n');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(directory, "preferences")), [
      "tui.json",
    ]);
    await saveThemePreference("terminal", path);
    assert.deepEqual(await loadThemePreference(path), { theme: "terminal" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid and unreadable preferences report errors and are never overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-theme-invalid-"));
  const path = join(directory, "tui.json");
  try {
    for (const bytes of [
      "{",
      '{"theme":"unknown"}',
      '{"extra":true}',
      "null",
    ]) {
      await writeFile(path, bytes);
      const preference = await loadThemePreference(path);
      assert.equal(preference.theme, "terminal");
      assert.match(preference.error ?? "", /Unable to read/u);
      await assert.rejects(
        saveThemePreference("latte", path),
        /Unable to read/u,
      );
      assert.equal(await readFile(path, "utf8"), bytes);
    }
    await writeFile(path, "{}");
    assert.deepEqual(await loadThemePreference(path), { theme: "terminal" });
    const unreadable = join(directory, "directory-instead-of-file");
    await mkdir(unreadable);
    assert.match(
      (await loadThemePreference(unreadable)).error ?? "",
      /Unable to read/u,
    );
    await assert.rejects(
      saveThemePreference("latte", unreadable),
      /Unable to read/u,
    );
    assert.deepEqual(await readdir(unreadable), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["on", "off"] as const) {
  test(`a sigil ${mode} setting survives an independent theme change`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "fungi-sigils-"));
    const path = join(directory, "tui.json");
    try {
      await writeFile(
        path,
        JSON.stringify({ theme: "terminal", sigils: mode }),
      );
      assert.deepEqual(await loadThemePreference(path), {
        theme: "terminal",
        sigils: mode,
      });
      await saveThemePreference("latte", path);
      assert.deepEqual(await loadThemePreference(path), {
        theme: "latte",
        sigils: mode,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
