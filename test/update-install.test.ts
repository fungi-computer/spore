import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  symlink,
  readlink,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { installFungiCandidate } from "../src/update-install.js";

async function fixture(failNew: boolean) {
  const root = await mkdtemp(join(tmpdir(), "fungi-update-install-"));
  const old = join(root, "old.cjs");
  const candidate = join(root, "candidate.cjs");
  const link = join(root, "fungi");
  await writeFile(
    old,
    `#!/usr/bin/env node\nconst fs=require('node:fs'); const path=require('node:path'); if(process.argv[2]==='sessions') fs.writeFileSync(path.join(__dirname,'service.state'),'old'); process.exit(0);\n`,
    {
      mode: 0o700,
    },
  );
  await writeFile(
    candidate,
    `#!/usr/bin/env node\nconst fs=require('node:fs'); const path=require('node:path'); if(process.argv[2]==='sessions') fs.writeFileSync(path.join(__dirname,'service.state'),'new'); process.exit(process.argv[2] === 'sessions' && ${String(failNew)} ? 1 : 0);\n`,
    { mode: 0o700 },
  );
  await symlink("old.cjs", link);
  return { root, candidate, link };
}

test("a failed post-swap resume restores the exact old relative launcher target", async () => {
  const f = await fixture(true);
  try {
    await assert.rejects(
      installFungiCandidate(f.link, f.candidate, f.root),
      /restored the previous launcher and Local service/,
    );
    expect(await readlink(f.link)).toBe("old.cjs");
    expect(await readFile(join(f.root, "service.state"), "utf8")).toBe("old");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a healthy candidate becomes the launcher after its Local service reopens", async () => {
  const f = await fixture(false);
  try {
    await installFungiCandidate(f.link, f.candidate, f.root);
    expect(await readlink(f.link)).toBe(f.candidate);
    expect(await readFile(join(f.root, "service.state"), "utf8")).toBe("new");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("rollback reports a candidate stop failure while restoring the previous launcher and service", async () => {
  const f = await fixture(true);
  try {
    await writeFile(f.candidate, "#!/usr/bin/env node\nprocess.exit(1);\n");
    await assert.rejects(
      installFungiCandidate(f.link, f.candidate, f.root),
      /candidate service could not be stopped/,
    );
    expect(await readlink(f.link)).toBe("old.cjs");
    expect(await readFile(join(f.root, "service.state"), "utf8")).toBe("old");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
