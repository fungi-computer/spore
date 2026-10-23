import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import {
  bindTuiUpdateRestart,
  renderTuiConnecting,
} from "../src/frame-renderer.js";
import * as notifications from "../src/update-notifications.js";

test("the production frame mounts one update watcher and refuses an unbound restart without exiting", async () => {
  let notify: ((notice: notifications.UpdateNotification) => void) | undefined;
  let mounts = 0;
  let closed = 0;
  const watch = spyOn(notifications, "watchFungiUpdates").mockImplementation(
    (listener) => {
      mounts++;
      notify = listener;
      return () => {
        closed++;
      };
    },
  );
  const setup = await testRender(<box />, { width: 80, height: 20 });
  const root = createRoot(setup.renderer);
  try {
    act(() => {
      renderTuiConnecting(root);
    });
    act(() => {
      renderTuiConnecting(root);
    });
    expect(mounts).toBe(1);
    act(() => {
      notify?.({ kind: "restart", version: "1.1.0" });
    });
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("Restart to update"));
    });
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Restart to update"));
    const x = (lines[y] ?? "").indexOf("Restart to update");
    await act(async () => {
      await setup.mockMouse.click(x, y);
    });
    await act(async () => {
      await setup.waitForFrame((frame) =>
        frame.includes("Restart is unavailable"),
      );
    });
    expect(setup.captureCharFrame()).toContain("Restart to update failed");
    expect(closed).toBe(0);
  } finally {
    act(() => {
      root.unmount();
      setup.renderer.destroy();
    });
    watch.mockRestore();
  }
  expect(closed).toBe(1);
});

test("a production restart binding has one owner and can be released", async () => {
  const setup = await testRender(<box />, { width: 80, height: 20 });
  const root = createRoot(setup.renderer);
  const render = spyOn(root, "render");
  const restart = () => Promise.reject(new Error("Refused restart"));
  let release: (() => void) | undefined;
  try {
    act(() => {
      release = bindTuiUpdateRestart(root, restart);
    });
    expect(() => bindTuiUpdateRestart(root, restart)).toThrow(
      "already owns an update restart action",
    );
    release?.();
    release = bindTuiUpdateRestart(root, restart);
    expect(render).not.toHaveBeenCalled();
  } finally {
    release?.();
    render.mockRestore();
    act(() => {
      root.unmount();
      setup.renderer.destroy();
    });
  }
});
