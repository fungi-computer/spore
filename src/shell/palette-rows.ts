import type {
  WhistleCommandKey,
  WhistlePaletteProjection,
} from "@fungi.computer/whistle";
import type { TerminalChoice } from "../button/picker-rows.js";

/** Keep command identity and owner copy intact across grouping and recents. */
export function paletteRows(
  rows: readonly WhistlePaletteProjection[],
  recents: readonly string[],
): readonly (TerminalChoice &
  Readonly<{ commandId: string; command: WhistleCommandKey }>)[] {
  const recent = [...new Set(recents)]
    .flatMap((id) => rows.filter((row) => row.commandId === id))
    .slice(0, 3);
  const recentIds = new Set(recent.map((row) => row.commandId));
  const choice = (row: WhistlePaletteProjection, group = row.category) => ({
    commandId: row.commandId,
    command: row.command,
    name: row.title,
    description: row.description,
    group,
  });
  return [
    ...recent.map((row) => choice(row, "Recent")),
    ...rows
      .filter((row) => !recentIds.has(row.commandId))
      .map((row) => choice(row)),
  ];
}
