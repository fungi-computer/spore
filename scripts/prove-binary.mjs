import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { expectReportedVersion } from "@fungi.computer/cli-version";

const sourceBinary = resolve(
  process.argv[2] ?? "../../.botanical/dist/fungi/fungi-linux-x64",
);
const root = await mkdtemp(join(tmpdir(), "fungi-binary-proof-"));
const binary = join(root, ".fungi/bin/fungi");
// No ambient credentials and no Node/Bun on PATH. Every child uses this home.
const env = {
  HOME: root,
  USERPROFILE: root,
  FUNGI_INSTALL: join(root, ".fungi"),
  PATH: "/nonexistent",
  TERM: "dumb",
  NO_COLOR: "1",
};
function run(args) {
  const result = spawnSync(binary, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}
try {
  const checksum = await readFile(`${sourceBinary}.sha256`, "utf8");
  const server = createServer((request, response) => {
    if (request.url?.endsWith(".sha256")) response.end(checksum);
    else createReadStream(sourceBinary).pipe(response);
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  try {
    const address = server.address();
    assert.ok(address);
    const installed = await promisify(execFile)(
      "sh",
      [new URL("../../../install.sh", import.meta.url).pathname],
      {
        env: {
          ...env,
          PATH: process.env.PATH,
          FUNGI_RELEASE_URL: `http://127.0.0.1:${address.port}`,
        },
        timeout: 30_000,
      },
    );
    assert.match(installed.stdout, /Checksum verified/u);
    console.log(installed.stdout.replaceAll(root, "<temporary-home>"));
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  const version = run(["--version"]);
  const builds = await readdir(join(root, ".fungi/runtime"));
  assert.equal(builds.length, 1, "The binary extracts one runtime");
  // Qualify the supplied artifact, not an unrelated local bundler output.
  const manifest = z
    .object({ name: z.literal("@fungi.computer/spore"), version: z.string() })
    .parse(
      JSON.parse(
        await readFile(
          join(root, ".fungi/runtime", builds[0], "package.json"),
          "utf8",
        ),
      ),
    );
  assert.ok(
    expectReportedVersion(version, manifest.version),
    "Installed CLI version must satisfy the published updater",
  );
  console.log("$ fungi --version\n" + version);
  assert.match(run([]), /Welcome to fungi/u);
  const firstRun = run(["--yes"]);
  assert.match(
    firstRun,
    /Welcome to fungi\. Use your Claude or ChatGPT subscription \(recommended\), or sign in to Fungi to use models/u,
  );
  console.log("$ fungi --yes\n" + firstRun);
  const setup = JSON.parse(
    await readFile(join(root, ".fungi/onboarding.json"), "utf8"),
  );
  assert.equal(setup.door, "later");
  assert.match(run(["sessions", "list"]), /No saved conversations/u);
  const record = JSON.parse(
    await readFile(join(root, ".fungi/service/service.json"), "utf8"),
  );
  const status = await fetch(
    `${record.baseUrl}/service/${record.serviceId}/status`,
  );
  assert.equal(status.status, 200);
  assert.deepEqual(
    await readdir(join(root, ".fungi/runtime")),
    builds,
    "Concurrent/repeated launches share one extracted runtime",
  );
  const node = join(root, ".fungi/runtime", builds[0], "native/bin/node");
  assert.equal(spawnSync(node, ["--version"], { env }).status, 0);
  console.log(
    "PASS: compiled CLI version, piped first run, --yes, native library load, embedded Node and background-service restart without Node/Bun on PATH",
  );
} finally {
  try {
    run(["stop"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
