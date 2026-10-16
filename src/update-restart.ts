import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";

export type UpdateRestartSession = Readonly<{
  invocationRoot: string;
  sessionId: string;
}>;
export type InstalledUpdateRestart =
  | Readonly<{ kind: "waiting" }>
  | Readonly<{
      kind: "restart";
      launcher: string;
      session: UpdateRestartSession;
    }>;
const statusSchema = z.object({
  schemaVersion: z.literal(2),
  sessionId: z.string().min(1),
  activity: z.object({
    queue: z.object({ state: z.enum(["idle", "queued", "running"]) }),
  }),
});

async function installedBuildId(launcher: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(join(dirname(launcher), "cli.js")))
    .digest("hex");
}

/** Ask the installed build about activity; the old client cannot connect to its service. */
export async function installedUpdateRestart(
  link: string,
  runningLauncher: string,
  sessions: readonly UpdateRestartSession[],
  runningBuildId = process.env.FUNGI_BUNDLED_BUILD_ID,
): Promise<InstalledUpdateRestart | undefined> {
  const launcher = await realpath(link);
  if (sessions.length === 0) return undefined;
  // npm replaces the bundle in place; its launcher's path stays unchanged.
  const buildId =
    launcher === runningLauncher &&
    runningBuildId !== undefined &&
    basename(launcher) === "fungi.cjs" &&
    basename(dirname(launcher)) === "dist"
      ? await installedBuildId(launcher)
      : undefined;
  if (
    launcher === runningLauncher &&
    (buildId === undefined || buildId === runningBuildId)
  )
    return undefined;
  for (const session of sessions) {
    const child = Bun.spawn(
      [
        launcher,
        "sessions",
        "status",
        session.sessionId,
        "--json",
        "-C",
        session.invocationRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0)
      throw new Error(
        "Installed Fungi could not check the saved Session before restarting",
        { cause: new Error(stderr) },
      );
    const status = statusSchema.parse(JSON.parse(stdout));
    if (status.sessionId !== session.sessionId)
      throw new Error(
        "Installed Fungi selected a different Session during update",
      );
    if (status.activity.queue.state !== "idle") return { kind: "waiting" };
  }
  if ((await realpath(link)) !== launcher) return { kind: "waiting" };
  if (buildId !== undefined && (await installedBuildId(launcher)) !== buildId)
    return { kind: "waiting" };
  const session = sessions[0];
  if (session === undefined) return undefined;
  return { kind: "restart", launcher, session };
}

/** Run only after the old client's terminal and Session scopes have closed. */
export async function resumeInstalledUpdate(
  update: Extract<InstalledUpdateRestart, { kind: "restart" }>,
): Promise<void> {
  const child = Bun.spawn(
    [
      update.launcher,
      "sessions",
      "resume",
      update.session.sessionId,
      "-C",
      update.session.invocationRoot,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  const code = await child.exited;
  if (code !== 0)
    throw new Error(
      `Updated Fungi exited with status ${String(code)}; run fungi sessions resume ${update.session.sessionId} -C ${update.session.invocationRoot}`,
    );
}
