import { expect, test } from "bun:test";
import { createWhistle } from "@fungi.computer/whistle";
import { paletteRows } from "../src/shell/palette-rows.js";
import { pickerRows } from "../src/button/picker-rows.js";

const commands = createWhistle();
commands.contribute({
  sourceId: "picker-test",
  namespace: "picker-test",
  commands: [
    ...["New", "Resume", "Goal", "Loop", "Plan", "Fork", "Answer"].map(
      (title, order) => ({
        id: title,
        title,
        category: "Conversation",
        projections: { palette: { order } },
        handler: () => undefined,
      }),
    ),
    {
      id: "Model",
      title: "Model",
      category: "Settings",
      projections: { palette: { order: 7 } },
      handler: () => undefined,
    },
    {
      id: "Split",
      title: "Split panes",
      category: "Panes",
      projections: { palette: { order: 8 } },
      handler: () => undefined,
    },
    {
      id: "Inspect",
      title: "Session status",
      category: "Advanced",
      projections: { palette: { order: 9 } },
      handler: () => undefined,
    },
  ],
});
const catalog = commands.snapshot().palette;

test("grouped default stays short, with one expansion row retaining every command", () => {
  const choices = paletteRows(catalog, []);
  const rows = pickerRows(choices, {
    collapsedGroups: ["Panes", "Advanced"],
    visibleLimit: 6,
    collapsedLabel: "More commands",
  });
  expect(rows.length).toBeLessThanOrEqual(9);
  expect(rows.filter((row) => row.kind === "choice")).toHaveLength(6);
  expect(rows.filter((row) => row.kind === "expand")).toEqual([
    { kind: "expand", label: "More commands (4)…" },
  ]);
  const all = pickerRows(choices, {
    collapsedGroups: ["Panes", "Advanced"],
    visibleLimit: 6,
    expanded: true,
  });
  expect(all.filter((row) => row.kind === "choice")).toHaveLength(10);
  expect(
    all.filter((row) => row.kind === "heading").map((row) => row.label),
  ).toEqual(["CONVERSATION", "SETTINGS", "PANES", "ADVANCED"]);
});

test("recents deduplicate, ignore withdrawn commands and keep only the last three live ids", () => {
  const choices = paletteRows(catalog, [
    "picker-test:Model",
    "missing",
    "picker-test:Model",
    "picker-test:Loop",
    "picker-test:Goal",
    "picker-test:New",
  ]);
  expect(
    choices.filter((row) => row.group === "Recent").map((row) => row.name),
  ).toEqual(["Model", "Loop", "Goal"]);
  expect(new Set(choices.map((row) => row.commandId)).size).toBe(
    catalog.length,
  );
  expect(choices).toHaveLength(catalog.length);
});

test("search reaches collapsed groups and overflow without changing execution identity", () => {
  const choices = paletteRows(catalog, []);
  const rows = pickerRows(choices, {
    query: "split",
    collapsedGroups: ["Panes", "Advanced"],
    visibleLimit: 6,
  });
  expect(rows).toMatchObject([
    { kind: "heading", label: "PANES" },
    {
      kind: "choice",
      choice: { name: "Split panes", commandId: "picker-test:Split" },
      index: 8,
    },
  ]);
});

test("the short default respects catalog priority before grouping", () => {
  const choices = [
    { name: "New", group: "Conversation" },
    { name: "Model", group: "Settings" },
    { name: "Resume", group: "Conversation" },
  ];
  expect(
    pickerRows(choices, { visibleLimit: 2 })
      .filter((row) => row.kind === "choice")
      .map((row) => row.choice.name),
  ).toEqual(["New", "Model"]);
});

test("recents plus two open categories keep expansion inside the nine-row default", () => {
  const choices = [
    { name: "Grow", group: "Recent" },
    { name: "Shrink", group: "Recent" },
    { name: "New", group: "Conversation" },
    { name: "Model", group: "Settings" },
    { name: "Thinking", group: "Settings" },
    { name: "Goal", group: "Conversation" },
    { name: "Loop", group: "Conversation" },
  ];
  const rows = pickerRows(choices, { visibleLimit: 6, rowLimit: 9 });
  expect(rows.length).toBeLessThanOrEqual(9);
  expect(rows.at(-1)).toEqual({ kind: "expand", label: "More choices (4)…" });
  expect(
    rows.filter((row) => row.kind === "choice").map((row) => row.choice.name),
  ).toEqual(["Grow", "Shrink", "New"]);
  expect(
    pickerRows(choices, {
      visibleLimit: 6,
      rowLimit: 9,
      expanded: true,
    }).filter((row) => row.kind === "choice"),
  ).toHaveLength(7);
  expect(
    pickerRows(choices, { visibleLimit: 6, rowLimit: 9, query: "Model" }),
  ).toMatchObject([
    { kind: "heading", label: "SETTINGS" },
    { kind: "choice", index: 3 },
  ]);
});
