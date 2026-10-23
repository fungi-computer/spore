import { act } from "react";
import type { Setup } from "./frame-capture.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Manual React roots own the test environment through their awaited teardown. */
export function enterReactActEnvironment(): () => void {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  };
}

/**
 * OpenTUI resets the act environment in its synchronous onDestroy callback.
 * Keep React's diagnostics enabled until the outer act flushes unmount effects,
 * then preserve the environment selected by the SDK.
 * Dispose caller-owned bindings before the flush.
 */
export async function destroyTestRenderer(
  setup: Pick<Setup, "renderer">,
  afterDestroy?: () => void,
) {
  let environment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  try {
    await act(() =>
      Promise.resolve().then(() => {
        try {
          setup.renderer.destroy();
        } finally {
          environment = globalThis.IS_REACT_ACT_ENVIRONMENT;
          globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        }
        afterDestroy?.();
      }),
    );
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = environment;
  }
}
