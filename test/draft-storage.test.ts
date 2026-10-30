import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tuiDraftStorage } from "../src/button/draft-storage.js";

test("TUI draft storage removes only the requested key and tolerates absent keys", () => {
  const scope = randomUUID();
  const obsolete = `fungi.parakeet.drafts.v1:${scope}`;
  const current = `fungi.parakeet.drafts.v2:${scope}`;
  tuiDraftStorage.setItem(obsolete, "Disposable draft");
  tuiDraftStorage.setItem(current, "Current draft");

  tuiDraftStorage.removeItem(obsolete);
  tuiDraftStorage.removeItem(obsolete);
  expect(tuiDraftStorage.getItem(obsolete)).toBeNull();
  expect(tuiDraftStorage.getItem(current)).toBe("Current draft");
  tuiDraftStorage.removeItem(current);
});
