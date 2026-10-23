import { expect, test } from "bun:test";
import { pickerRows } from "../src/button/picker-rows.js";

const openai = { name: "OpenAI", description: "ChatGPT", group: "Signed in" };
const anthropic = { name: "Anthropic", group: "Popular" };
const deepseek = {
  name: "DeepSeek",
  description: "API key",
  group: "More providers",
};
const openrouter = { name: "OpenRouter", group: "More providers" };
const choices = [openai, anthropic, deepseek, openrouter];
test("fuzzy search finds Zoom pane by zp and preserves its original answer index", () => {
  const zoom = { name: "Zoom pane" };
  const rows = pickerRows(
    [{ name: "Close pane" }, zoom, { name: "Open pane" }],
    {
      query: "zp",
    },
  );
  expect(rows).toMatchObject([{ kind: "choice", choice: zoom, index: 1 }]);
  const row = rows[0];
  expect(row?.kind === "choice" ? row.choice : undefined).toBe(zoom);
});

test("groups have headings and spacing; collapsed choices retain original answer indexes", () => {
  expect(pickerRows(choices, { collapsedGroups: ["More providers"] })).toEqual([
    { kind: "heading", label: "SIGNED IN" },
    { kind: "choice", choice: openai, index: 0, positions: new Set() },
    { kind: "blank" },
    { kind: "heading", label: "POPULAR" },
    { kind: "choice", choice: anthropic, index: 1, positions: new Set() },
    { kind: "blank" },
    { kind: "expand", label: "More providers (2)…" },
  ]);
  expect(
    pickerRows(choices, {
      collapsedGroups: ["More providers"],
      expanded: true,
    }).slice(-3),
  ).toEqual([
    { kind: "heading", label: "MORE PROVIDERS" },
    { kind: "choice", choice: deepseek, index: 2, positions: new Set() },
    { kind: "choice", choice: openrouter, index: 3, positions: new Set() },
  ]);
});

test("clp finds Close pane and an exact prefix beats a scattered match", () => {
  const close = { name: "Close pane" };
  expect(
    pickerRows([{ name: "Open pane" }, close], { query: "clp" }),
  ).toMatchObject([{ kind: "choice", choice: close, index: 1 }]);
  expect(
    pickerRows([{ name: "Cancel pending action" }, close], { query: "cl" }),
  ).toMatchObject([
    { kind: "choice", choice: close, index: 1 },
    { kind: "choice", index: 0 },
  ]);
});

test("search reaches collapsed choices and descriptions without changing answers", () => {
  expect(
    pickerRows(choices, {
      collapsedGroups: ["More providers"],
      query: "API KEY",
    }),
  ).toEqual([
    { kind: "heading", label: "MORE PROVIDERS" },
    {
      kind: "choice",
      choice: deepseek,
      index: 2,
      positions: new Set([9, 10, 11, 12, 13, 14, 15]),
    },
  ]);
  expect(pickerRows(choices, { query: "missing" })).toEqual([]);
});
