import type { Setup } from "./frame-capture.js";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";

/** Render until an observable outcome arrives, including external query notifications. */
export async function waitForFrame(
  setup: Pick<Setup, "renderOnce" | "captureCharFrame" | "renderer">,
  predicate: (frame: string) => boolean | Promise<boolean>,
) {
  const signal = globalThis.AbortSignal.timeout(2000);
  const render = async () => {
    await act(async () => setup.renderOnce());
    return setup.captureCharFrame();
  };
  let frame = await render();
  if (await predicate(frame)) return frame;
  try {
    while (!signal.aborted) {
      await act(async () => {
        await delay(10, undefined, { signal });
        await setup.renderOnce();
      });
      frame = setup.captureCharFrame();
      if (await predicate(frame)) return frame;
    }
  } catch (cause) {
    throw new Error(`Expected frame was not rendered:\n${frame}`, { cause });
  }
  throw new Error(`Expected frame was not rendered:\n${frame}`);
}

/**
 * Wait for output that arrives outside React (a PTY child's bytes): render,
 * check, then sleep a real interval so the event loop can deliver that output.
 * Bounded: a missing frame fails with the last screen instead of spinning.
 */
export async function waitForLiveFrame(
  setup: Pick<Setup, "renderOnce" | "captureCharFrame" | "renderer">,
  predicate: (frame: string) => boolean,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
    if (setup.renderer.isDestroyed)
      throw new Error("Renderer closed before the expected frame");
    if (Date.now() > deadline)
      throw new Error(`Expected live frame was not rendered:\n${frame}`);
    await delay(20);
  }
}

/** Await real decoding even when a keymap stops propagation to later listeners. */
export async function pressDecodedKey(
  setup: Pick<Setup, "renderOnce" | "captureCharFrame" | "renderer">,
  press: () => void,
) {
  const decoded = Promise.withResolvers<undefined>();
  const handler = () => {
    decoded.resolve(undefined);
  };
  setup.renderer.keyInput.prependListener("keypress", handler);
  const timeout = setTimeout(() => {
    decoded.reject(new Error("Key was not decoded"));
  }, 2000);
  try {
    await act(async () => {
      press();
      await decoded.promise;
    });
    await act(async () => setup.renderOnce());
  } finally {
    clearTimeout(timeout);
    setup.renderer.keyInput.off("keypress", handler);
  }
}
