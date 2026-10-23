import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { CopySurface } from "../src/button/copy-surface.js";
import { UpdateToasts, updateToast } from "../src/update-toasts.js";
import type { UpdateNotification } from "../src/update-notifications.js";

test("available updates keep the shared default duration; restart waits for explicit action", () => {
  const restart = () => undefined;
  expect(updateToast({ kind: "available", version: "1.1.0" }, restart)).toEqual(
    {
      variant: "info",
      message: "Fungi 1.1.0 is available: run fungi update",
    },
  );
  expect(updateToast({ kind: "restart", version: "1.1.0" }, restart)).toEqual({
    variant: "info",
    message: "Update installed: restart to update",
    duration: "until-dismissed",
    action: { label: "Restart to update", run: restart },
  });
});

test("update facts use the shared toast and its restart action, then release the watcher", async () => {
  let notify: ((notice: UpdateNotification) => void) | undefined;
  let closed = false;
  let restarts = 0;
  const setup = await testRender(
    <CopySurface>
      <UpdateToasts
        watch={(listener) => {
          notify = listener;
          return () => {
            closed = true;
          };
        }}
        restart={() => {
          restarts++;
        }}
      />
    </CopySurface>,
    { width: 80, height: 20 },
  );
  try {
    act(() => {
      notify?.({ kind: "available", version: "1.1.0" });
    });
    await act(async () => {
      await setup.waitForFrame((frame) =>
        frame.includes("Fungi 1.1.0 is available: run fungi update"),
      );
    });
    act(() => {
      setup.mockInput.pressEscape();
      notify?.({ kind: "restart", version: "1.1.0" });
    });
    await act(async () => {
      await setup.waitForFrame((frame) => frame.includes("Restart to update"));
    });
    // The shared card wraps its message beside the action at this width.
    expect(setup.captureCharFrame()).toContain("Update installed: restart to");
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Restart to update"));
    const x = (lines[y] ?? "").indexOf("Restart to update");
    await act(async () => {
      await setup.mockMouse.click(x, y);
    });
    expect(restarts).toBe(1);
    await act(async () => {
      await setup.waitForFrame(
        (frame) => !frame.includes("Update installed: restart to"),
      );
    });
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
  expect(closed).toBe(true);
});
