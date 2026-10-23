import { reportFailure, type PaneKit } from "../../button/index.js";

/**
 * Close or quit admission: an idle shell goes at once, running jobs ask
 * first, and a failed inspection keeps the jobs alive and says why.
 */
export async function admitTerminalTermination(
  hasRunningJobs: () => Promise<boolean>,
  confirm: () => Promise<boolean>,
  toast: PaneKit["toast"],
): Promise<boolean> {
  try {
    return !(await hasRunningJobs()) || (await confirm());
  } catch (cause) {
    toast({
      variant: "error",
      duration: "until-dismissed",
      message:
        "Could not check shell jobs. Shells are still running; try again.",
    });
    reportFailure("local-terminal-quit-inspection", cause);
    return false;
  }
}
