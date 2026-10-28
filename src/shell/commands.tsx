import { paletteRows } from "./palette-rows.js";
import { displayText } from "./display-text.js";
import { useEffect, useRef } from "react";
import type { AppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import type {
  WhistleCommand,
  WhistleCommandKey,
} from "@fungi.computer/whistle";
import {
  Picker,
  reportFailure,
  type DialogController,
  type ToastInput,
  type TuiPresentation,
} from "../button/index.js";
import type { createPaneRegistry, PaneOpenDirection } from "./registry.js";

export type PaneShellCommandOptions = Readonly<{
  registry: ReturnType<typeof createPaneRegistry>;
  host: AppSurfaceCommandHost;
  dialog: DialogController;
  colors: TuiPresentation["colors"];
  /** Choose among every pane that can open right now. */
  openPane: (direction?: PaneOpenDirection) => void | Promise<void>;
  toast: (input: ToastInput) => void;
}>;

/** TUI command declarations use the installed OpenTUI binding grammar. */
export function usePaneShellCommands(options: PaneShellCommandOptions) {
  const current = useRef(options);
  current.current = options;
  const recents = useRef<readonly string[]>([]);
  const run = (operation: () => void | Promise<void>) => {
    void Promise.resolve()
      .then(operation)
      .catch((cause: unknown) => {
        current.current.toast({
          variant: "error",
          duration: "until-dismissed",
          message: "Pane command failed. Try again.",
        });
        return reportFailure("pane-shell-command", cause);
      });
  };
  const execute = (
    row: Readonly<{ commandId: string; command: WhistleCommandKey }>,
  ) => {
    const { commandId } = row;
    run(async () => {
      const outcome = await current.current.host.execute(row.command, {
        origin: "keyboard",
      });
      if (outcome.status === "handled")
        recents.current = [
          commandId,
          ...recents.current.filter((id) => id !== commandId),
        ].slice(0, 3);
      else
        current.current.toast({
          variant: "error",
          duration: "until-dismissed",
          message:
            outcome.status === "failed"
              ? displayText(outcome.error.message)
              : "Pane command is unavailable.",
        });
    });
  };
  const commandLine = () => {
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
            execute(row);
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
    const focus = (step: -1 | 1) => {
      const next = adjacent(step);
      if (next !== undefined) current.current.registry.focus(next);
    };
    const swap = (step: -1 | 1) => {
      const first = focused();
      const next = adjacent(step);
      if (first !== undefined && next !== undefined)
        current.current.registry.swap(first, next);
    };
    const windowCommand = (
      id: string,
      title: string,
      values: readonly string[],
      order: number,
      handler: () => void,
    ) => ({
      id,
      title,
      category: "Panes",
      projections: {
        bindings: { values, order },
        palette: { order: 10 + order },
        help: { order },
      },
      handler,
    });
    const shell: readonly WhistleCommand<never>[] = [
      {
        id: "open-app",
        title: "Open pane",
        category: "Panes",
        description: "Choose a terminal, program, conversation or App.",
        projections: {
          bindings: { values: ["<leader>o"], order: 0 },
          palette: { order: 0 },
        },
        handler: () => {
          run(current.current.openPane);
        },
      },
      {
        id: "show-command-palette",
        title: "Show commands",
        category: "Panes",
        handler: commandLine,
      },
      {
        id: "command-line",
        title: "All commands",
        category: "Panes",
        projections: {
          bindings: { values: ["<leader><leader>", "<leader>:"], order: 7 },
        },
        handler: commandLine,
      },
      windowCommand("zoom", "Zoom pane", ["alt+enter", "<leader>z"], 2, () => {
        const id = focused();
        if (id !== undefined) current.current.registry.toggleZoom(id);
      }),
      windowCommand(
        "focus-previous",
        "Focus left",
        ["alt+left", "<leader>h"],
        3,
        () => {
          focus(-1);
        },
      ),
      windowCommand(
        "focus-next",
        "Focus right",
        ["alt+right", "<leader>l"],
        4,
        () => {
          focus(1);
        },
      ),
      windowCommand(
        "swap-previous",
        "Move pane left",
        ["alt+shift+left", "<leader>{"],
        5,
        () => {
          swap(-1);
        },
      ),
      windowCommand(
        "swap-next",
        "Move pane right",
        ["alt+shift+right", "<leader>}"],
        6,
        () => {
          swap(1);
        },
      ),
      {
        id: "pane-close",
        title: "Close pane",
        category: "Panes",
        projections: {
          palette: { order: 1 },
          bindings: { values: ["<leader>x"], order: 1 },
        },
        handler: () => {
          const id = focused();
          return id === undefined
            ? Promise.resolve()
            : current.current.registry.close(id);
        },
      },
      ...(
        [
          ["beside", ["<leader>v", "<leader>%"]],
          ["below", ["<leader>s", '<leader>"']],
        ] as const
      ).map(([direction, bindings]) => ({
        id: `pane-open-${direction}`,
        title: `Open pane ${direction}`,
        category: "Panes",
        projections: {
          palette: { order: 1 },
          bindings: { values: [...bindings], order: 12 },
        },
        handler: () => {
          run(() => current.current.openPane(direction));
        },
      })),
      ...(
        [
          ["main-left", "Main on left"],
          ["main-top", "Main on top"],
          ["columns", "Equal columns"],
          ["rows", "Equal rows"],
          ["grid", "Grid"],
        ] as const
      ).map(([layout, title]) => ({
        id: `layout-${layout}`,
        title: `Layout: ${title}`,
        category: "Panes",
        projections: { palette: { order: 2 } },
        handler: () => {
          current.current.registry.setLayout(layout);
        },
      })),
      {
        id: "layout-next",
        title: "Next layout",
        category: "Panes",
        projections: {
          palette: { order: 2 },
          bindings: { values: ["<leader> "], order: 8 },
        },
        handler: () => {
          current.current.registry.cycleLayout();
        },
      },
      ...[-4, 4].map((delta) => ({
        id: delta < 0 ? "pane-shrink" : "pane-grow",
        title: delta < 0 ? "Shrink main pane" : "Grow main pane",
        category: "Panes",
        projections: {
          palette: { order: 3 },
          bindings: {
            values: [delta < 0 ? "<leader><" : "<leader>>"],
            order: delta < 0 ? 9 : 10,
          },
        },
        handler: () => {
          current.current.registry.resizeBy(delta);
        },
      })),
      {
        id: "pane-equalize",
        title: "Equalize panes",
        category: "Panes",
        projections: {
          palette: { order: 3 },
          bindings: { values: ["<leader>="], order: 11 },
        },
        handler: () => {
          current.current.registry.equalize();
        },
      },
    ];
    // A program's key never takes one the shell or an earlier program holds;
    // it still opens from Open pane and the palette.
    const taken = new Set(
      shell.flatMap((command) =>
        (command.projections?.bindings?.values ?? []).map(normalBinding),
      ),
    );
    const programs = current.current.registry.launchers.flatMap((launcher) => {
      if (launcher.binding === undefined) return [];
      const key = normalBinding(launcher.binding);
      const free = !taken.has(key);
      if (free) taken.add(key);
      else
        reportFailure(
          "pane-launcher-binding-taken",
          new Error(
            `${launcher.target.kind} asked for ${launcher.binding}, which is taken`,
          ),
        );
      return [
        {
          // A program kind is `extension:<id>.<terminal>`; command ids hold no colon.
          id: `open-${launcher.target.kind.replaceAll(":", "-")}`,
          title: `Open ${launcher.name.toLowerCase()}`,
          category: "Panes",
          description: launcher.description,
          projections: free
            ? {
                bindings: { values: [launcher.binding], order: 13 },
                palette: { order: 1 },
              }
            : { palette: { order: 1 } },
          handler: () => {
            run(async () => {
              const outcome = await current.current.registry.open(
                launcher.target,
                true,
                { direction: "beside", afterPaneId: focused() ?? null },
              );
              if (outcome.kind === "refused")
                current.current.toast({
                  variant: "error",
                  message: outcome.reason,
                });
            });
          },
        },
      ];
    });
    return options.host.registerShellCommands([...shell, ...programs]);
  }, [options.host, options.registry]);
}

/** Bindings compare without surrounding space. */
function normalBinding(binding: string): string {
  return binding.trim();
}
