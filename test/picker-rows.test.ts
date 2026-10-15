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
test("groups have headings and spacing; collapsed choices retain original answer indexes", () => {
  expect(pickerRows(choices, { collapsedGroups: ["More providers"] })).toEqual([
    { kind: "heading", label: "SIGNED IN" },
    { kind: "choice", choice: openai, index: 0 },
    { kind: "blank" },
    { kind: "heading", label: "POPULAR" },
    { kind: "choice", choice: anthropic, index: 1 },
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
    { kind: "choice", choice: deepseek, index: 2 },
    { kind: "choice", choice: openrouter, index: 3 },
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
    { kind: "choice", choice: deepseek, index: 2 },
  ]);
  expect(pickerRows(choices, { query: "missing" })).toEqual([]);
});
