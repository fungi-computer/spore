import { createContext, useContext } from "react";
import type { RGBA } from "@opentui/core";
import { toolKindSigils } from "@fungi.computer/parakeet/headless";

/** Transcript gutter sigils: one per tool kind, plus the run-error row. */
export const gutterSigils = Object.freeze({
  ...toolKindSigils,
  error: "error",
} as const);

/** Terminal-owned ordinary placeholder cells available to every pane. */
export type ToolSigilGlyph = Readonly<{ text: string; color: RGBA }>;
export type ToolSigils = Readonly<
  Record<keyof typeof gutterSigils, ToolSigilGlyph>
>;
export const ToolSigilContext = createContext<ToolSigils | undefined>(
  undefined,
);
export const useToolSigils = () => useContext(ToolSigilContext);
