import type { EmbeddedTerminalRenderable } from "@opentui/core";

// OpenTUI's React components registry is extended by interface declaration merging.
declare module "@opentui/react" {
  interface OpenTUIComponents {
    fungiTerminal: typeof EmbeddedTerminalRenderable;
  }
}
