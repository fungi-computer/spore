import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { waitForLiveFrame } from "./native-readiness.js";

/**
 * The gate hang: a PTY wait rendered frame after frame with no delay and no
 * deadline, so a line that never arrived kept a core busy forever. A live
 * wait must reject at its own deadline without spinning. Gate load can delay
 * delivery of that deadline; elapsed time and process-wide CPU are not its law.
 */
test("a live-frame wait for output that never comes rejects at its deadline, without spinning", async () => {
  const setup = await testRender(<text>idle</text>, { width: 40, height: 5 });
  try {
    let renders = 0;
    await assert.rejects(
      waitForLiveFrame(
        {
          ...setup,
          renderOnce: async () => {
            renders += 1;
            await setup.renderOnce();
          },
        },
        (frame) => frame.includes("never shown"),
        600,
      ),
      /Expected live frame was not rendered:/u,
    );
    // The existing waiter paces renders at 20 ms: at most 30 intervals in
    // 600 ms, plus the initial render and the deadline-observing render.
    expect(renders).toBeGreaterThan(0);
    expect(renders).toBeLessThanOrEqual(32);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
