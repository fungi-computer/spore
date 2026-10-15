import { useEffect, useRef } from "react";
import {
  contributeReloadCommand,
  type ReloadSource,
} from "@fungi.computer/parakeet/headless";
import type { WhistleRuntime } from "@fungi.computer/whistle";

/** Keybindings come from command projections; there is no binding file to re-read. */
const keybindings: ReloadSource = {
  name: "keybindings",
  effect: "unsupported",
  reason: "bindings come from commands; there is no keybinding file",
};

/**
 * The pane's `/reload`: the model catalog and terminal colors re-read through
 * their owners now; host sources describe themselves. Nothing restarts.
 */
export function useReloadControls(
  input: Readonly<{
    commands: Pick<WhistleRuntime, "contribute">;
    refreshModels: (() => Promise<void>) | undefined;
    refreshColors: () => void;
    hostSources: readonly ReloadSource[] | undefined;
  }>,
) {
  const view = useRef(input);
  view.current = input;
  const { commands } = input;
  useEffect(() => {
    const lease = contributeReloadCommand(commands, {
      sourceId: "tui-frame",
      namespace: "tui",
      sources: () => {
        const current = view.current;
        const refreshModels = current.refreshModels;
        const pane: ReloadSource[] = [
          {
            name: "terminal colors",
            effect: "now",
            reload: () => {
              current.refreshColors();
              return Promise.resolve();
            },
          },
          keybindings,
        ];
        if (refreshModels !== undefined)
          pane.push({
            name: "model catalog",
            effect: "now",
            reload: refreshModels,
          });
        return [...pane, ...(current.hostSources ?? [])];
      },
    });
    return () => {
      lease.dispose();
    };
  }, [commands]);
}
