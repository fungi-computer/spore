import { EmbeddedTerminalRenderable } from "@opentui/core";
import { extend } from "@opentui/react";

// The maintained OpenTUI React extension mounts the native terminal within
// the pane's ordinary layout. No second VT parser or cell projection.
extend({ fungiTerminal: EmbeddedTerminalRenderable });

export { EmbeddedTerminalRenderable };
