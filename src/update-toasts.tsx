import { useEffect } from "react";
import { useToast, type ToastInput } from "./button/index.js";
import {
  watchFungiUpdates,
  type UpdateNotification,
} from "./update-notifications.js";

export type RestartAction = NonNullable<ToastInput["action"]>["run"];
export function updateToast(
  notice: UpdateNotification,
  restart: RestartAction,
): ToastInput {
  if (notice.kind === "available")
    return {
      variant: "info",
      message: `Fungi ${notice.version} is available: run fungi update`,
    };
  return {
    variant: "info",
    message: "Update installed: restart to update",
    duration: "until-dismissed",
    action: { label: "Restart to update", run: restart },
  };
}

/** No renderer or timer here: the shared toast provider owns presentation. */
export function UpdateToasts({
  restart,
  watch = watchFungiUpdates,
}: Readonly<{
  restart: RestartAction;
  watch?: typeof watchFungiUpdates;
}>) {
  const toast = useToast();
  useEffect(
    () =>
      watch((notice) => {
        toast.show(updateToast(notice, restart));
      }),
    [toast, watch, restart],
  );
  return null;
}
