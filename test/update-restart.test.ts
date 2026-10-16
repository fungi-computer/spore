import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedUpdateRestart } from "../src/update-restart.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  // Match the running launcher's canonical path, including macOS /private/tmp.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-update-restart-")),
  );
  roots.push(root);
  const old = join(root, "old");
  const next = join(root, "next");
  const link = join(root, "fungi");
  const state = join(root, "state.json");
  await writeFile(old, "old launcher");
  await writeFile(
    next,
    `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst state=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));\nconst id=process.argv[4];\nconsole.log(JSON.stringify({schemaVersion:2,sessionId:id,activity:{queue:{state:state[id]}}}));\n`,
  );
  await chmod(next, 0o755);
  await symlink(next, link);
  const selected = { invocationRoot: root, sessionId: "session-original" };
  return { root, old, next, link, state, selected };
}
test("an installed update resumes the exact idle Session through the new launcher", async () => {
  const f = await fixture();
  await writeFile(f.state, JSON.stringify({ "session-original": "idle" }));
  expect(await installedUpdateRestart(f.link, f.old, [f.selected])).toEqual({
    kind: "restart",
    launcher: f.next,
    session: f.selected,
  });
});
test("an installed update waits for every selected running or queued Session, then restarts once idle", async () => {
  const f = await fixture();
  const other = { invocationRoot: f.root, sessionId: "session-other" };
  for (const state of ["running", "queued"]) {
    await writeFile(
      f.state,
      JSON.stringify({ "session-original": "idle", "session-other": state }),
    );
    expect(
      await installedUpdateRestart(f.link, f.old, [f.selected, other]),
    ).toEqual({ kind: "waiting" });
  }
  await writeFile(
    f.state,
    JSON.stringify({ "session-original": "idle", "session-other": "idle" }),
  );
  expect(
    await installedUpdateRestart(f.link, f.old, [f.selected, other]),
  ).toEqual({ kind: "restart", launcher: f.next, session: f.selected });
});

test("an unchanged installed launcher never queries or restarts a Session", async () => {
  const f = await fixture();
  expect(
    await installedUpdateRestart(f.link, f.next, [f.selected]),
  ).toBeUndefined();
});
