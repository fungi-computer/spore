import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { latestFungiVersion, releaseVersion } from "./release-registry.js";
import { loadThemePreference } from "./button/theme-preferences.js";
import { reportFailure } from "./button/log-event.js";

/** Update facts only; the shared toast UI owns copy, duration, and actions. */
export type UpdateNotification = Readonly<{
  kind: "available" | "restart";
  version: string;
}>;

/** One terminal lifetime owns a nonblocking check and at most one in-flight request. */
export function startUpdateNotifications(
  options: Readonly<{
    running: string;
    policy: () => Promise<"off" | "notify">;
    installed: () => Promise<string>;
    registry: (signal: AbortSignal) => Promise<string>;
    notify: (notice: UpdateNotification) => void;
    reportFailure: (cause: unknown) => void;
    schedule?: (tick: () => void, milliseconds: number) => () => void;
  }>,
): () => void {
  const controller = new AbortController();
  const cancelled = () => controller.signal.aborted;
  let checking = false;
  let available = options.running;
  let installedNotice = options.running;
  const poll = async () => {
    if ((await options.policy()) === "off" || cancelled()) return;
    const installed = releaseVersion.parse(await options.installed());
    if (cancelled()) return;
    if (Bun.semver.order(installed, installedNotice) > 0) {
      options.notify({ kind: "restart", version: installed });
      installedNotice = installed;
    }
    const latest = releaseVersion.parse(
      await options.registry(controller.signal),
    );
    if (cancelled()) return;
    if (
      Bun.semver.order(latest, installed) > 0 &&
      Bun.semver.order(latest, available) > 0
    ) {
      options.notify({ kind: "available", version: latest });
      available = latest;
    }
  };
  const check = async () => {
    if (checking || cancelled()) return;
    checking = true;
    try {
      await poll();
    } catch (cause) {
      options.reportFailure(cause);
    } finally {
      checking = false;
    }
  };
  const tick = () => {
    void check();
  };
  const schedule =
    options.schedule ??
    ((callback, milliseconds) => {
      const timer = setInterval(callback, milliseconds);
      timer.unref();
      return () => {
        clearInterval(timer);
      };
    });
  const cancel = schedule(tick, 600_000);
  tick();
  return () => {
    controller.abort();
    cancel();
  };
}

const packageVersion = z.object({ version: releaseVersion });
const runningVersion = packageVersion.parse(
  createRequire(import.meta.url)("../package.json"),
).version;

/** Source checkouts do not poll the registry; installed clients use their own manifest. */
export function watchFungiUpdates(
  notify: (notice: UpdateNotification) => void,
): () => void {
  const launcher = process.env.FUNGI_LAUNCHER;
  if (launcher === undefined || basename(launcher) !== "fungi.cjs")
    return () => undefined;
  let installedLauncher: string | undefined;
  return startUpdateNotifications({
    running: runningVersion,
    policy: async () => {
      const preference = await loadThemePreference();
      if (preference.error !== undefined) throw new Error(preference.error);
      return preference.update ?? "notify";
    },
    installed: async () => {
      if (installedLauncher === undefined) {
        const { findReleaseInstall } = await import("./update.js");
        installedLauncher = (await findReleaseInstall()).launcher;
      }
      const current = await realpath(installedLauncher);
      return packageVersion.parse(
        JSON.parse(
          await readFile(
            join(dirname(dirname(current)), "package.json"),
            "utf8",
          ),
        ),
      ).version;
    },
    registry: latestFungiVersion,
    notify,
    reportFailure: (cause) => {
      reportFailure("update-check", cause);
    },
  });
}
