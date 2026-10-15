import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";

export const themeNames = ["terminal", "mocha", "latte"] as const;
export type ThemeName = (typeof themeNames)[number];
const preferencesSchema = z.strictObject({
  theme: z.enum(themeNames).default("terminal"),
  sigils: z.enum(["auto", "on", "off"]).optional(),
});
const fileErrorSchema = z.object({ code: z.string() });
const defaultPath = () => join(homedir(), ".config", "fungi", "tui.json");

export type ThemePreference = Readonly<{
  theme: ThemeName;
  sigils?: "auto" | "on" | "off" | undefined;
  error?: string;
}>;

/** Invalid preferences remain visible and untouched, including on a later save. */
export async function loadThemePreference(
  path = defaultPath(),
): Promise<ThemePreference> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const parsed = preferencesSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        "expected theme terminal, mocha, or latte; sigils auto, on, or off",
      );
    return parsed.data;
  } catch (error) {
    const fileError = fileErrorSchema.safeParse(error);
    if (fileError.success && fileError.data.code === "ENOENT")
      return { theme: "terminal" };
    return {
      theme: "terminal",
      error: `Unable to read ${path}: ${error instanceof Error ? error.message : "invalid preferences"}`,
    };
  }
}

/** Confirmed choices use the maintained atomic writer. */
export async function saveThemePreference(
  theme: ThemeName,
  path = defaultPath(),
): Promise<void> {
  const current = await loadThemePreference(path);
  if (current.error) throw new Error(current.error);
  const value: ThemePreference =
    current.sigils === undefined
      ? { theme }
      : { theme, sigils: current.sigils };
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
}
