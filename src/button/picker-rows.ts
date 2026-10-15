export type TerminalChoice = Readonly<{
  name: string;
  description?: string | undefined;
  group?: string | undefined;
}>;

export type PickerRow =
  | Readonly<{ kind: "heading"; label: string }>
  | Readonly<{ kind: "blank" }>
  | Readonly<{ kind: "choice"; choice: TerminalChoice; index: number }>
  | Readonly<{ kind: "expand"; label: string }>;

/** Preserve answer indexes while grouping, filtering and hiding optional choices. */
export function pickerRows(
  choices: readonly TerminalChoice[],
  {
    query = "",
    collapsedGroups = [],
    expanded = false,
    collapsedLabel,
    visibleLimit = Infinity,
    rowLimit = Infinity,
  }: Readonly<{
    query?: string;
    collapsedGroups?: readonly string[] | undefined;
    collapsedLabel?: string | undefined;
    visibleLimit?: number | undefined;
    rowLimit?: number | undefined;
    expanded?: boolean;
  }> = {},
): readonly PickerRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const ranked = choices
    .map((choice, index) => {
      const name = choice.name.toLocaleLowerCase();
      const rank =
        !needle || name.startsWith(needle)
          ? 0
          : name.includes(needle)
            ? 1
            : (choice.description ?? "").toLocaleLowerCase().includes(needle)
              ? 2
              : 3;
      return { choice, index, rank };
    })
    .filter((entry) => entry.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const groups = new Map<string | undefined, typeof ranked>();
  for (const entry of ranked) {
    const group = groups.get(entry.choice.group) ?? [];
    group.push(entry);
    groups.set(entry.choice.group, group);
  }
  const visible = new Set<number>();
  const visibleGroups = new Set<string | undefined>();
  for (const entry of ranked) {
    if (!expanded && !needle) {
      if (
        entry.choice.group !== undefined &&
        collapsedGroups.includes(entry.choice.group)
      )
        continue;
      const nextGroups = new Set([...visibleGroups, entry.choice.group]);
      const headings = [...nextGroups].filter(
        (group) => group !== undefined,
      ).length;
      const spacing = Math.max(0, nextGroups.size - 1);
      const expansion = visible.size + 1 < ranked.length ? 2 : 0;
      if (
        visible.size >= visibleLimit ||
        visible.size + 1 + headings + spacing + expansion > rowLimit
      )
        break;
    }
    visible.add(entry.index);
    visibleGroups.add(entry.choice.group);
  }
  const rows: PickerRow[] = [];
  const hidden = ranked.length - visible.size;
  for (const [group, entries] of groups) {
    const shown = entries.filter(({ index }) => visible.has(index));
    if (shown.length === 0) continue;
    if (rows.length > 0) rows.push({ kind: "blank" });
    if (group !== undefined)
      rows.push({ kind: "heading", label: group.toLocaleUpperCase() });
    for (const { choice, index } of shown)
      rows.push({ kind: "choice", choice, index });
  }
  if (hidden > 0) {
    if (rows.length > 0) rows.push({ kind: "blank" });
    const label =
      collapsedLabel ??
      (collapsedGroups.length === 1 ? collapsedGroups[0] : undefined) ??
      "More choices";
    rows.push({ kind: "expand", label: `${label} (${String(hidden)})…` });
  }
  return rows;
}
