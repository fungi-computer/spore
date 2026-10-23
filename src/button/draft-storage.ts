import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { ParakeetDraftStorage } from "@fungi.computer/parakeet/headless";

/** The terminal's crash-safe Parakeet storage; journal grammar stays with Parakeet. */
export const tuiDraftStorage: ParakeetDraftStorage = {
  getItem(key) {
    try {
      return readFileSync(pathFor(key), "utf8");
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return null;
      throw cause;
    }
  },
  setItem(key, value) {
    const directory = join(homedir(), ".fungi", "drafts");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileAtomic.sync(pathFor(key), value, { mode: 0o600, fsync: true });
  },
};

function pathFor(key: string): string {
  return join(
    homedir(),
    ".fungi",
    "drafts",
    `${createHash("sha256").update(key).digest("hex")}.json`,
  );
}
