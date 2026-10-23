import { basename, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { readInstalledLocalClientBuildId } from "@fungi.computer/truffle/service";
import { z } from "zod";
import type { ParakeetDraftCheckpoint } from "@fungi.computer/parakeet/headless";

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
      ? await readInstalledLocalClientBuildId(launcher)
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
  if (
    buildId !== undefined &&
    (await readInstalledLocalClientBuildId(launcher)) !== buildId
  )
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
export type UpdateDraftCheckpoint = () => ParakeetDraftCheckpoint;
type RegisteredCheckpoint = Readonly<{ checkpoint: UpdateDraftCheckpoint }>;

/** Only live callback registrations, never draft text or journal state. */
export function createUpdateDraftCheckpointBarrier() {
  const mounted = new Map<string, Set<RegisteredCheckpoint>>();
  return {
    register: (
      address: string,
      checkpoint: UpdateDraftCheckpoint,
    ): (() => void) => {
      const active = mounted.get(address) ?? new Set<RegisteredCheckpoint>();
      const registration = { checkpoint };
      active.add(registration);
      mounted.set(address, active);
      return () => {
        if (!active.delete(registration)) return;
        if (active.size === 0) mounted.delete(address);
      };
    },
    checkpoint: (addresses: readonly string[]): void => {
      if (addresses.length === 0)
        throw new Error("No selected Session is ready to checkpoint");
      for (const address of addresses)
        if (!mounted.has(address))
          throw new Error(
            "A selected conversation is not ready to save its draft",
          );
      // Save other mounted panes too. The caller must hand off synchronously
      // after this returns; Parakeet owns all journal writes and later hydration.
      for (const active of mounted.values())
        for (const { checkpoint } of active) {
          const result = checkpoint();
          if (result.status === "failed")
            throw new Error(`Restart cancelled: ${result.reason}`);
        }
    },
  };
}
