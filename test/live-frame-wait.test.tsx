import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { waitForLiveFrame } from "./native-readiness.js";

/**
 * The gate hang: a PTY wait rendered frame after frame with no delay and no
 * deadline, so a line that never arrived kept a core busy forever. A live
 * wait must fail on time and leave the CPU to the work it waits for.
 */
test("a live-frame wait for output that never comes fails on time, without spinning", async () => {
  const setup = await testRender(<text>idle</text>, { width: 40, height: 5 });
  try {
    const started = Date.now();
    const cpu = process.cpuUsage();
    const outcome = await waitForLiveFrame(
      setup,
      (frame) => frame.includes("never shown"),
      600,
    ).catch((cause: unknown) => cause);
    const used = process.cpuUsage(cpu);
    const elapsed = Date.now() - started;
    expect(outcome).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(3_000);
    // A spin uses about one core for the whole wait; a paced wait far less.
    expect((used.user + used.system) / 1000).toBeLessThan(elapsed * 0.5);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
