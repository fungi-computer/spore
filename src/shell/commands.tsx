import { paletteRows } from "./palette-rows.js";
import { displayText } from "./display-text.js";
import { useEffect, useRef } from "react";
import type { KeyEvent } from "@opentui/core";
import { shellCommands } from "@fungi.computer/oyster/shell/commands";
import {
  leaderKeys,
  leaderKeyMatches,
} from "@fungi.computer/oyster/shell/keys";
import type { AppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import {
  Picker,
  reportFailure,
  type DialogController,
  type TuiPresentation,
  type PaneNotice,
} from "../button/index.js";
import type { createPaneRegistry } from "./registry.js";

export type PaneShellCommandOptions = Readonly<{
  registry: ReturnType<typeof createPaneRegistry>;
  host: AppSurfaceCommandHost;
  dialog: DialogController;
  colors: TuiPresentation["colors"];
  /** Choose among every pane that can open right now. */
  openPane: () => void | Promise<void>;
  notify: (notice: PaneNotice) => void;
}>;

/** Commands and leader choices read the same active Whistle projection. */
export function usePaneShellCommands(options: PaneShellCommandOptions) {
  const current = useRef(options);
  current.current = options;
  const recents = useRef<readonly string[]>([]);
  const leader = useRef<ReturnType<DialogController["show"]>>();
  const run = (operation: () => void | Promise<void>) => {
    void Promise.resolve()
      .then(operation)
      .catch((cause: unknown) => {
        current.current.notify({
          tone: "error",
          message: "Pane command failed. Try again.",
        });
        return reportFailure("pane-shell-command", cause);
      });
  };
  const execute = (commandId: string) => {
    run(async () => {
      const outcome = await current.current.host.execute(commandId, {
        origin: "keyboard",
      });
      if (outcome.status === "handled")
        recents.current = [
          commandId,
          ...recents.current.filter((id) => id !== commandId),
        ].slice(0, 3);
      else
        current.current.notify({
          tone: "error",
          message:
            outcome.status === "failed"
              ? displayText(outcome.error.message)
              : "Pane command is unavailable.",
        });
    });
  };
  const commandLine = () => {
    leader.current = undefined;
    const view = current.current;
    const rows = paletteRows(view.host.active().palette, recents.current);
    view.dialog.show((handle) => (
      <Picker
        title="Commands"
        colors={view.colors}
        searchable
        descriptionWrap={false}
        collapsedGroups={["Panes", "Advanced"]}
        collapsedLabel="More commands"
        visibleLimit={6}
        rowLimit={9}
        choices={rows}
        onCancel={handle.dismiss}
        onSelect={(index) => {
          const row = rows[index];
          if (row !== undefined) {
            handle.dismiss();
            execute(row.commandId);
          }
        }}
      />
    ));
  };
  const showKeys = () => {
    if (leader.current?.isCurrent()) {
      commandLine();
      return;
    }
    const view = current.current;
    const rows = leaderKeys(view.host.active());
    leader.current = view.dialog.show((handle) => (
      <Picker
        title="Panes"
        colors={view.colors}
        choices={rows.map((row) => ({
          name: displayText(row.title),
          description: row.key,
        }))}
        onCancel={handle.dismiss}
        onSelect={(index) => {
          const row = rows[index];
          if (row !== undefined) {
            handle.dismiss();
            execute(row.commandId);
          }
        }}
      />
    ));
  };
  useEffect(() => {
    const focused = () =>
      current.current.registry.read().find((pane) => pane.focused)?.paneId;
    const adjacent = (step: -1 | 1) => {
      const panes = current.current.registry.read();
      const index = panes.findIndex((pane) => pane.focused);
      return panes[(index + step + panes.length) % panes.length]?.paneId;
    };
    return options.host.registerShellCommands([
      ...shellCommands({
        openApp: () => {
          run(current.current.openPane);
        },
        showKeys,
        showCommandLine: commandLine,
        focusStep: (step) => {
          const next = adjacent(step);
          if (next !== undefined) current.current.registry.focus(next);
        },
        swapStep: (step) => {
          const first = focused();
          const next = adjacent(step);
          if (first !== undefined && next !== undefined)
            current.current.registry.swap(first, next);
        },
        toggleZoom: () => {
          const id = focused();
          if (id !== undefined) current.current.registry.toggleZoom(id);
        },
      }).map((command) => {
        let title = command.title;
        let order = command.projections?.bindings?.order;
        switch (command.id) {
          case "open-app":
            title = "Open pane";
            break;
          case "show-command-palette":
            title = "Panes";
            break;
          case "command-line":
            title = "All commands";
            order = 7;
            break;
          case "zoom":
            title = "Zoom pane";
            order = 2;
            break;
          case "focus-previous":
            title = "Focus left";
            order = 3;
            break;
          case "focus-next":
            title = "Focus right";
            order = 4;
            break;
          case "swap-previous":
            title = "Move pane left";
            order = 5;
            break;
          case "swap-next":
            title = "Move pane right";
            order = 6;
            break;
        }
        const bindings = command.projections?.bindings;
        const adapted = {
          ...command,
          title,
          category: "Panes",
          description:
            command.id === "open-app"
              ? "Choose a terminal, program, conversation or App."
              : command.description,
        };
        if (bindings === undefined) return adapted;
        return {
          ...adapted,
          projections: {
            ...command.projections,
            bindings: {
              ...bindings,
              order,
              values:
                command.id === "show-command-palette"
                  ? ["ctrl+k"]
                  : bindings.values,
            },
          },
        };
      }),
      {
        id: "pane-close",
        title: "Close pane",
        category: "Panes",
        projections: {
          palette: { order: 1 },
          bindings: { values: ["<leader> x"], order: 1 },
        },
        handler: () => {
          const id = focused();
          return id === undefined
            ? Promise.resolve()
            : current.current.registry.close(id);
        },
      },
      ...(["x", "y"] as const).map((axis) => ({
        id: `pane-split-${axis}`,
        title:
          axis === "x" ? "Split panes horizontally" : "Split panes vertically",
        category: "Panes",
        projections: { palette: { order: 2 } },
        handler: () => {
          current.current.registry.split(axis);
        },
      })),
      ...[-4, 4].map((delta) => ({
        id: delta < 0 ? "pane-shrink" : "pane-grow",
        title: delta < 0 ? "Shrink main pane" : "Grow main pane",
        category: "Panes",
        projections: { palette: { order: 3 } },
        handler: () => {
          current.current.registry.resizeBy(delta);
        },
      })),
    ]);
  }, [options.host, options.registry]);
  return (key: KeyEvent) => {
    if (leader.current?.isCurrent() !== true) return false;
    if (key.ctrl && key.name === "k") {
      commandLine();
      return true;
    }
    const row = leaderKeys(current.current.host.active()).find((candidate) =>
      leaderKeyMatches(
        {
          key: key.name,
          altKey: key.option,
          ctrlKey: key.ctrl,
          metaKey: key.meta,
        },
        candidate.key,
      ),
    );
    if (row === undefined) return false;
    leader.current.dismiss();
    execute(row.commandId);
    return true;
  };
}
