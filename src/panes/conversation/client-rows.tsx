import { terminalText, terminalCellWidth } from "../../button/index.js";
import type { RowV1 } from "@fungi.computer/gills";
import {
  placeClientTimeline,
  useClientActions,
  useClientContributions,
  useTimeline,
  type ParakeetCommandRuntime,
  type ClientContribution,
} from "@fungi.computer/parakeet/headless";
import { useEffect, useRef, useState } from "react";
import {
  fitFooterCaption,
  sigilGutterText,
  sigilGutterTotalWidth,
} from "../../button/index.js";
import type { TuiPresentation } from "../../button/index.js";

const toneColor = {
  attention: "warning",
  running: "info",
  error: "error",
  settled: "success",
  muted: "foreground",
} as const;

function rowColor(
  row: ClientContribution["value"]["panel"][number],
  focusedRowId: string | undefined,
  presentation: TuiPresentation,
): TuiPresentation["colors"]["primary"] {
  return row.id === focusedRowId
    ? presentation.colors.primary
    : presentation.colors[
        row.tone === undefined ? "foreground" : toneColor[row.tone]
      ];
}

/**
 * Both pinned and committed rows use the shared data grammar. Every row
 * reserves the shared left gutter -- blank when it carries no tone -- so a
 * row's text starts in the same column as its toned siblings, and lines up
 * with the timeline's own gutter.
 */
export function TerminalClientRows({
  rows,
  presentation,
  id,
  compactWidth,
  focusedRowId,
  expandedRowId,
  onOpen,
}: Readonly<{
  id?: string;
  /** A click on a row with an open target opens it, as Row actions → Open does. */
  onOpen?: ((target: NonNullable<RowV1["open"]>) => void) | undefined;
  compactWidth?: number;
  focusedRowId?: string | undefined;
  expandedRowId?: string | undefined;
  rows: ClientContribution["value"]["panel"];
  presentation: TuiPresentation;
}>) {
  return (
    <box
      {...(id === undefined ? {} : { id })}
      flexDirection="column"
      marginX={1}
    >
      {rows.map((row) => (
        <box
          key={row.id}
          flexDirection="column"
          {...(row.open === undefined || onOpen === undefined
            ? {}
            : {
                onMouseDown: () => {
                  if (row.open !== undefined) onOpen(row.open);
                },
              })}
        >
          <box
            flexDirection="row"
            {...(compactWidth === undefined || row.id === expandedRowId
              ? {}
              : { height: 1 })}
          >
            <text
              width={sigilGutterTotalWidth}
              flexShrink={0}
              fg={rowColor(row, focusedRowId, presentation)}
            >
              {sigilGutterText(row.tone === undefined ? "" : "●")}
            </text>
            <text
              flexGrow={1}
              flexShrink={1}
              {...(compactWidth === undefined || row.id === expandedRowId
                ? {}
                : { height: 1, wrapMode: "none" as const })}
              fg={rowColor(row, focusedRowId, presentation)}
            >
              {compactWidth === undefined || row.id === expandedRowId
                ? terminalText(row.title)
                : row.inspection === undefined
                  ? fitFooterCaption(
                      terminalText(
                        [row.title, row.detail].filter(Boolean).join(" · "),
                      ),
                      Math.max(0, compactWidth - sigilGutterTotalWidth),
                    )
                  : fitFooterCaption(
                      terminalText(row.title),
                      Math.max(
                        0,
                        compactWidth -
                          sigilGutterTotalWidth -
                          (row.detail === undefined
                            ? 0
                            : terminalCellWidth(terminalText(row.detail)) + 3),
                      ),
                    )}
              {compactWidth !== undefined &&
              row.id !== expandedRowId &&
              row.inspection !== undefined &&
              row.detail !== undefined
                ? ` · ${terminalText(row.detail)}`
                : ""}
            </text>
          </box>
          {row.detail === undefined ||
          (compactWidth !== undefined && row.id !== expandedRowId) ? null : (
            <text
              marginLeft={sigilGutterTotalWidth}
              fg={presentation.colors.foreground}
              attributes={2}
            >
              {terminalText(row.detail)}
            </text>
          )}
        </box>
      ))}
    </box>
  );
}

/** Existing Whistle choice dialogs provide keyboard reach to admitted row actions. */
export function useClientRowCommands(
  commands: ParakeetCommandRuntime,
  onOpen?: (target: NonNullable<RowV1["open"]>) => void | Promise<void>,
) {
  const entries = useClientContributions();
  const timeline = useTimeline();
  const actions = useClientActions(commands);
  const [selecting, setSelecting] = useState(false);
  const current = useRef({ entries, timeline, actions, onOpen });
  current.current = { entries, timeline, actions, onOpen };
  useEffect(() => {
    const lease = commands.contribute({
      sourceId: "tui-client-rows",
      namespace: "tui-rows",
      commands: [
        {
          id: "actions",
          title: "Row actions",
          category: "Advanced",
          projections: {
            palette: { order: 1 },
          },
          handler: async ({ interaction }) => {
            if (interaction === undefined)
              throw new Error("Row actions require a human interaction");
            const { entries, timeline, actions, onOpen } = current.current;
            const placed = placeClientTimeline(
              entries,
              timeline.commandAnchors,
              timeline.positionAnchors,
            );
            const visible = [...placed.after.values()]
              .flat()
              .concat(placed.before)
              .concat(placed.unanchored);
            const rows = entries
              .flatMap(({ entryId, value }) =>
                value.panel.map((row) => ({ entryId, row })),
              )
              .concat(
                visible.flatMap(({ entryId, cell }) =>
                  cell.rows.map((row) => ({ entryId, row })),
                ),
              )
              .filter(
                ({ row }) =>
                  (row.actions?.length ?? 0) > 0 ||
                  (row.open !== undefined && onOpen !== undefined),
              );
            if (rows.length === 0) {
              interaction.notify({
                type: "info",
                message: "No row actions are available.",
              });
              return;
            }
            setSelecting(true);
            try {
              const selected = await interaction.prompt({
                type: "choice",
                message: "Choose a row",
                options: rows.map(({ entryId, row }, index) => ({
                  value: String(index),
                  label: row.title,
                  description: entryId,
                })),
              });
              const row = rows.find(
                (_row, index) => String(index) === selected,
              );
              if (row === undefined)
                throw new Error("The selected row is unavailable");
              const choices = row.row.actions ?? [];
              const options = choices.map((action, index) => ({
                value: String(index),
                label: action.label,
              }));
              if (row.row.open !== undefined && onOpen !== undefined)
                options.unshift({ value: "open", label: "Open" });
              const selectedAction = await interaction.prompt({
                type: "choice",
                message: "Choose an action",
                options,
              });
              if (selectedAction === "open") {
                const target = row.row.open;
                if (target === undefined || onOpen === undefined)
                  throw new Error("The selected open target is unavailable");
                await interaction.run(async () => {
                  await onOpen(target);
                });
                return;
              }
              const action = choices.find(
                (_action, index) => String(index) === selectedAction,
              );
              if (action === undefined)
                throw new Error("The selected row action is unavailable");
              setSelecting(false);
              await interaction.run(() => actions.execute(row.entryId, action));
            } finally {
              setSelecting(false);
            }
          },
        },
      ],
    });
    return () => {
      lease.dispose();
    };
  }, [commands]);
  return { ...actions, selecting };
}
