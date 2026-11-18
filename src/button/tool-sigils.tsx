import { createContext, useContext } from "react";
import type { RGBA } from "@opentui/core";
import { toolKindSigils } from "@fungi.computer/parakeet/headless";

/**
 * Transcript gutter marks: one Sigil per tool kind, the run-error status bead
 * (drawn by build-tool-sigils, never a bang), and the Agent-message Sigil.
 */
export const gutterSigils = Object.freeze({
  ...toolKindSigils,
  error: "error",
  agent: "agent",
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
