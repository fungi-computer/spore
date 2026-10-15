import { spawn } from "node:child_process";
import { readFungiAccountStatus } from "@fungi.computer/local";
import {
  openLocalTeamApps,
  type LocalTeamApps,
} from "@fungi.computer/local/apps";
import type { PaneApps } from "./button/index.js";

/** Browser handoff remains in the shell; no pane receives a credential. */
function openBrowser(url: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "darwin" ? "open" : "xdg-open",
      [url.href],
      { stdio: "ignore" },
    );
    child.once("error", (cause) => {
      reject(new Error("The App could not open in your browser", { cause }));
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("The browser launcher did not open the App"));
    });
  });
}

/** Account selection is captured lazily when the member first opens Apps. */
export function createAppPaneService(
  open: () => Promise<LocalTeamApps> = openLocalTeamApps,
) {
  let owned: Promise<LocalTeamApps> | undefined;
  const acquire = () =>
    (owned ??= open().catch((cause: unknown) => {
      owned = undefined;
      throw cause;
    }));
  const apps: PaneApps = {
    signedIn: async () => (await readFungiAccountStatus())?.team !== undefined,
    read: async (signal) => (await acquire()).read(signal),
    requestGill: async (surfaceId, request, signal) =>
      (await acquire()).requestGill(surfaceId, request, signal),
    openUi: async (surfaceId, signal) =>
      openBrowser(await (await acquire()).surfaceUrl(surfaceId, signal)),
  };
  return {
    apps,
    openSession: async (
      target: Readonly<{ agentId: string; sessionId: string }>,
      signal: AbortSignal,
    ) => (await acquire()).openSession(target, signal),
  };
}
