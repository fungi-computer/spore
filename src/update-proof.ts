import { Database } from "bun:sqlite";
import { Terminal as Emulator } from "@xterm/headless";
import { mkdir, readdir, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ledgerRow = z.object({
  extension_id: z.string(),
  state_version: z.number().int().positive(),
});
const statusSchema = z.object({
  schemaVersion: z.literal(2),
  sessionId: z.string().min(1),
});

export type FungiCandidateProof = Readonly<{
  evidence: string;
  stateVersions: Readonly<Record<string, number>>;
}>;

function readStoreVersions(databasePath: string): Map<string, number> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return new Map(
      ledgerRow
        .array()
        .parse(
          database
            .query(
              "SELECT extension_id, state_version FROM shiitake_extension_state",
            )
            .all(),
        )
        .map((row) => [row.extension_id, row.state_version]),
    );
  } finally {
    database.close();
  }
}

/** SQLite supplies a consistent image, including committed WAL content. */
export async function copyUpdateStores(project: string, destination: string) {
  const directory = join(project, ".fungi/agents");
  const baseline = new Map<string, number>();
  const copied: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const source = join(directory, entry.name, "agent.sqlite");
    const info = await stat(source).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    if (!info?.isFile()) continue;
    const target = join(
      destination,
      ".fungi/agents",
      entry.name,
      "agent.sqlite",
    );
    await mkdir(join(destination, ".fungi/agents", entry.name), {
      recursive: true,
      mode: 0o700,
    });
    const database = new Database(source, { readonly: true });
    try {
      database.run("BEGIN");
      await writeFile(target, database.serialize(), { mode: 0o600 });
      database.run("COMMIT");
    } finally {
      database.close();
    }
    // A serialized WAL image has committed content but no WAL/SHM companions.
    // Normalize only this private copy before opening it read-only.
    const snapshot = new Database(target);
    try {
      const mode = snapshot
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode=DELETE")
        .get();
      if (mode?.journal_mode !== "delete")
        throw new Error("Copied Agent store could not leave WAL mode");
    } finally {
      snapshot.close();
    }
    for (const [id, version] of readStoreVersions(target))
      baseline.set(id, Math.max(baseline.get(id) ?? 0, version));
    copied.push(target);
  }
  if (copied.length === 0)
    throw new Error("No saved Agent stores to prove; update was not installed");
  return { baseline, copied };
}

async function candidateCommand(
  launcher: string,
  args: readonly string[],
  env: Record<string, string>,
  project: string,
) {
  const child = Bun.spawn([launcher, ...args], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Prove the actual packaged resume UI without credentials or a real-store write. */
export async function proveFungiCandidate(launcher: string, project: string) {
  const root = await mkdtemp(join(tmpdir(), "fungi-update-proof-"));
  const home = join(root, "home");
  const copy = join(root, "project");
  await mkdir(home, { mode: 0o700 });
  await mkdir(copy, { mode: 0o700 });
  const { baseline, copied } = await copyUpdateStores(project, copy);
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    TERM: "xterm-256color",
    HERDR_ENV: "1",
  };
  const counts = copied.map((path) => {
    const db = new Database(path, { readonly: true });
    try {
      return db.query("SELECT count(*) AS count FROM sessions").get();
    } finally {
      db.close();
    }
  });
  const emulator = new Emulator({
    cols: 160,
    rows: 48,
    scrollback: 0,
    allowProposedApi: true,
  });
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 48,
    data: (_terminal, bytes) => {
      emulator.write(bytes);
    },
  });
  let child: Bun.Subprocess | undefined;
  let proof: FungiCandidateProof;
  let stopped: boolean;
  try {
    const status = await candidateCommand(
      launcher,
      ["sessions", "status", "--last", "--json", "-C", copy],
      env,
      copy,
    );
    await writeFile(join(root, "status.stderr.log"), status.stderr, {
      mode: 0o600,
    });
    if (status.code !== 0)
      throw new Error(
        `Copied-store selection failed; inspect ${join(root, "status.stderr.log")}. No install was changed.`,
      );
    const selected = statusSchema.parse(JSON.parse(status.stdout));
    child = Bun.spawn([launcher, "resume", "--last", "-C", copy], {
      cwd: copy,
      env,
      terminal,
    });
    const deadline = Date.now() + 60_000;
    let rendered = false;
    while (Date.now() < deadline && child.exitCode === null) {
      const screen = Array.from(
        { length: 48 },
        (_, row) =>
          emulator.buffer.active.getLine(row)?.translateToString() ?? "",
      ).join("\n");
      if (screen.includes("Ask anything")) {
        rendered = true;
        break;
      }
      await Bun.sleep(50);
    }
    if (!rendered)
      throw new Error(
        "Copied-store resume did not render its conversation composer; no install was changed",
      );
    const reopened = await candidateCommand(
      launcher,
      ["sessions", "status", "--last", "--json", "-C", copy],
      env,
      copy,
    );
    if (
      reopened.code !== 0 ||
      statusSchema.parse(JSON.parse(reopened.stdout)).sessionId !==
        selected.sessionId
    )
      throw new Error(
        "Copied-store resume did not retain the latest saved Session; no install was changed",
      );
    const versions = new Map<string, number>();
    for (const [index, path] of copied.entries()) {
      const db = new Database(path, { readonly: true });
      try {
        const count = db.query("SELECT count(*) AS count FROM sessions").get();
        if (JSON.stringify(count) !== JSON.stringify(counts[index]))
          throw new Error(
            "Resume created an extra Session in the copy; no install was changed",
          );
      } finally {
        db.close();
      }
      for (const [id, version] of readStoreVersions(path))
        versions.set(id, Math.max(versions.get(id) ?? 0, version));
    }
    for (const [id, version] of baseline)
      if ((versions.get(id) ?? 0) < version)
        throw new Error(
          `Extension ${id} state version went backwards; no install was changed`,
        );
    proof = { evidence: root, stateVersions: Object.fromEntries(versions) };
  } finally {
    // Closing this private PTY does not signal a user pane or service.
    terminal.write("\x03");
    if (child !== undefined) {
      await Promise.race([child.exited, Bun.sleep(1_000)]);
      if (child.exitCode === null) child.kill();
    }
    terminal.close();
    emulator.dispose();
    const outcome = await candidateCommand(launcher, ["stop"], env, copy);
    await writeFile(join(root, "stop.stderr.log"), outcome.stderr, {
      mode: 0o600,
    });
    stopped = outcome.code === 0;
  }
  if (!stopped)
    throw new Error(`Copied-store proof service did not stop; inspect ${root}`);
  return proof;
}
