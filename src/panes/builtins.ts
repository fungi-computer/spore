import { gillPane } from "./gill/index.js";
import { conversationPane } from "./conversation/index.js";
import { terminalPane } from "./terminal/index.js";

/** Only the composition boundary names the registered builtin kinds. */
export const builtinPanes = [conversationPane, gillPane, terminalPane];
