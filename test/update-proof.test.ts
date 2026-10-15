import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyUpdateStores } from "../src/update-proof.js";

test("copied-store proof includes committed WAL data and ignores folders without a store", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-copy-stores-"));
  const source = join(root, "source");
  const copy = join(root, "copy");
  await mkdir(join(source, ".fungi/agents/empty"), { recursive: true });
  await mkdir(join(source, ".fungi/agents/saved"), { recursive: true });
  const database = new Database(
    join(source, ".fungi/agents/saved/agent.sqlite"),
  );
  try {
    database.run(
      "PRAGMA journal_mode=WAL; CREATE TABLE shiitake_extension_state(extension_id TEXT, state_version INTEGER); CREATE TABLE sessions(id TEXT); INSERT INTO shiitake_extension_state VALUES('botanical-session-goal',4); INSERT INTO sessions VALUES('saved-session');",
    );
    const result = await copyUpdateStores(source, copy);
    expect(result.baseline.get("botanical-session-goal")).toBe(4);
    expect(result.copied).toHaveLength(1);
    const copied = new Database(
      join(copy, ".fungi/agents/saved/agent.sqlite"),
      { readonly: true },
    );
    try {
      expect(copied.query("SELECT id FROM sessions").get()).toEqual({
        id: "saved-session",
      });
    } finally {
      copied.close();
    }
    expect(database.query("SELECT id FROM sessions").get()).toEqual({
      id: "saved-session",
    });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
