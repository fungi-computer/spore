import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { CopySurface } from "../src/button/copy-surface.js";
import {
  createToastStore,
  toastDurationMs,
  toastQueueLimit,
} from "../src/button/toast-store.js";
import { useToast, type ToastApi } from "../src/button/toast.js";
import { waitForFrame } from "./native-readiness.js";
import { captureFrame } from "./frame-capture.js";

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

test("a toast clears after the shared duration and the next queued one takes its place", () => {
  const store = createToastStore();
  store.show({ variant: "info", message: "first" });
  store.show({ variant: "warning", message: "second" });
  expect(store.snapshot().current?.message).toBe("first");
  expect(store.snapshot().pending).toBe(1);
  jest.advanceTimersByTime(toastDurationMs - 1);
  expect(store.snapshot().current?.message).toBe("first");
  jest.advanceTimersByTime(1);
  expect(store.snapshot().current?.message).toBe("second");
  expect(store.snapshot().pending).toBe(0);
  jest.advanceTimersByTime(toastDurationMs);
  expect(store.snapshot().current).toBeUndefined();
  store.dispose();
});

test("a named duration overrides the default and until-dismissed never expires", () => {
  const store = createToastStore();
  store.show({ variant: "info", message: "short", duration: 500 });
  jest.advanceTimersByTime(500);
  expect(store.snapshot().current).toBeUndefined();
  store.show({
    variant: "info",
    message: "stays",
    duration: "until-dismissed",
  });
  jest.advanceTimersByTime(toastDurationMs * 10);
  expect(store.snapshot().current?.message).toBe("stays");
  store.dismiss();
  expect(store.snapshot().current).toBeUndefined();
  store.dispose();
});

test("hover pauses the clock and resuming keeps the time that was left", () => {
  const store = createToastStore();
  store.show({ variant: "info", message: "hovered" });
  jest.advanceTimersByTime(1_000);
  store.pause();
  jest.advanceTimersByTime(toastDurationMs * 5);
  expect(store.snapshot().current?.message).toBe("hovered");
  store.resume();
  jest.advanceTimersByTime(toastDurationMs - 1_000 - 1);
  expect(store.snapshot().current?.message).toBe("hovered");
  jest.advanceTimersByTime(1);
  expect(store.snapshot().current).toBeUndefined();
  store.dispose();
});

test("activating a toast runs its action once and dismisses it; a plain toast just dismisses", () => {
  const store = createToastStore();
  let restarts = 0;
  store.show({
    variant: "info",
    message: "Update ready",
    action: {
      label: "Restart to update",
      run: () => {
        restarts += 1;
      },
    },
  });
  store.activate();
  expect(restarts).toBe(1);
  expect(store.snapshot().current).toBeUndefined();
  store.activate();
  expect(restarts).toBe(1);
  store.show({ variant: "error", message: "plain" });
  store.dismiss();
  expect(store.snapshot().current).toBeUndefined();
  expect(restarts).toBe(1);
  store.dispose();
});

test("the queue is bounded and drops its oldest waiting toast first", () => {
  const store = createToastStore();
  store.show({ variant: "info", message: "visible" });
  for (let index = 0; index < toastQueueLimit + 5; index += 1)
    store.show({ variant: "info", message: `queued ${String(index)}` });
  expect(store.snapshot().pending).toBe(toastQueueLimit);
  store.dismiss();
  expect(store.snapshot().current?.message).toBe("queued 5");
  store.dispose();
});

test("toast text is made safe for a terminal and bounded", () => {
  const store = createToastStore();
  store.show({
    variant: "error",
    message: "Bad\x1b[2J\x07" + "b".repeat(600),
  });
  const message = store.snapshot().current?.message ?? "";
  expect(message.length).toBeLessThanOrEqual(512);
  expect(message).not.toMatch(/\p{Cc}/u);
  store.dispose();
});

function Probe({ onApi }: Readonly<{ onApi: (api: ToastApi) => void }>) {
  onApi(useToast());
  return <text>body</text>;
}

async function mount() {
  let api: ToastApi | undefined;
  const setup = await testRender(
    <CopySurface>
      <Probe
        onApi={(value) => {
          api = value;
        }}
      />
    </CopySurface>,
    { width: 80, height: 12 },
  );
  return {
    setup,
    show: (...args: Parameters<ToastApi["show"]>) => {
      act(() => {
        api?.show(...args);
      });
    },
  };
}

test("a toast draws top-right with its action and a pending count, and Esc dismisses the top one", async () => {
  jest.useRealTimers();
  const { setup, show } = await mount();
  try {
    show({
      variant: "info",
      message: "Update ready",
      action: { label: "Restart to update", run: () => undefined },
    });
    show({ variant: "error", message: "Second one" });
    await waitForFrame(setup, (frame) => frame.includes("Restart to update"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("+1 more");
    await captureFrame(
      setup,
      process.env.TUI_TOAST_CAPTURE_DIR,
      "after-toast-action-pending",
    );
    const row = frame.split("\n").find((line) => line.includes("Update ready"));
    expect(row?.trimEnd().length).toBeGreaterThan(40);
    act(() => {
      setup.mockInput.pressEscape();
    });
    await waitForFrame(setup, (value) => value.includes("Second one"));
    expect(setup.captureCharFrame()).not.toContain("Update ready");
    act(() => {
      setup.mockInput.pressEscape();
    });
    await waitForFrame(setup, (value) => !value.includes("Second one"));
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("clicking a toast runs its action, and hovering it holds the toast past its duration", async () => {
  jest.useRealTimers();
  const { setup, show } = await mount();
  let ran = 0;
  try {
    show({
      variant: "success",
      message: "Update ready",
      duration: 150,
      action: {
        label: "Restart",
        run: () => {
          ran += 1;
        },
      },
    });
    await waitForFrame(setup, (frame) => frame.includes("Update ready"));
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Update ready"));
    const x = (lines[y] ?? "").indexOf("Update ready");
    await act(async () => {
      await setup.mockMouse.moveTo(x, y);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Update ready");
    await act(async () => {
      await setup.mockMouse.click(x, y);
    });
    await waitForFrame(setup, (frame) => !frame.includes("Update ready"));
    expect(ran).toBe(1);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("x dismisses an actionable toast without running its action", async () => {
  jest.useRealTimers();
  const { setup, show } = await mount();
  let ran = 0;
  try {
    show({
      variant: "info",
      message: "Update ready",
      action: {
        label: "Restart",
        run: () => {
          ran += 1;
        },
      },
    });
    await waitForFrame(setup, (frame) => frame.includes("Restart"));
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Restart"));
    const x = (lines[y] ?? "").lastIndexOf("x");
    expect(x).toBeGreaterThan(0);
    await act(async () => {
      await setup.mockMouse.click(x, y);
    });
    await waitForFrame(setup, (frame) => !frame.includes("Update ready"));
    expect(ran).toBe(0);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("an action paints pending, ignores repeat activation and Escape, then paints its warning", async () => {
  jest.useRealTimers();
  const { setup, show } = await mount();
  let refuse: ((cause: Error) => void) | undefined;
  const restart = new Promise<void>((_, reject) => {
    refuse = reject;
  });
  const settled = restart.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  let calls = 0;
  try {
    show({
      variant: "info",
      message: "Update installed",
      duration: "until-dismissed",
      action: {
        label: "Restart",
        run: () => {
          calls += 1;
          return restart;
        },
      },
    });
    await waitForFrame(setup, (frame) => frame.includes("Update installed"));
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Update installed"));
    const x = (lines[y] ?? "").indexOf("Update installed");
    await act(async () => {
      await setup.mockMouse.click(x, y);
    });
    await waitForFrame(setup, (frame) => frame.includes("Working…"));
    await captureFrame(
      setup,
      process.env.TUI_TOAST_CAPTURE_DIR,
      "review-action-pending",
    );
    await act(async () => {
      await setup.mockMouse.click(x, y);
      setup.mockInput.pressEscape();
    });
    expect(setup.captureCharFrame()).toContain("Working…");
    expect(calls).toBe(1);
    await act(async () => {
      refuse?.(new Error("Service restart failed"));
      expect(await settled).toBeInstanceOf(Error);
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Service restart failed"),
    );
    expect(setup.captureCharFrame()).toContain("Restart failed");
    expect(setup.captureCharFrame()).not.toContain("Working…");
    await captureFrame(
      setup,
      process.env.TUI_TOAST_CAPTURE_DIR,
      "review-action-warning",
    );
    act(() => {
      setup.mockInput.pressEscape();
    });
    await waitForFrame(
      setup,
      (frame) => !frame.includes("Service restart failed"),
    );
  } finally {
    refuse?.(new Error("test cleanup"));
    await settled;
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("attention overflow is visibly distinguished from the individually retained queue", async () => {
  jest.useRealTimers();
  const { setup, show } = await mount();
  try {
    show({ variant: "info", message: "visible", duration: "until-dismissed" });
    for (let index = 0; index < toastQueueLimit + 1; index += 1)
      show({
        variant: "error",
        message: `failure ${String(index)}`,
        duration: "until-dismissed",
      });
    await waitForFrame(setup, (frame) =>
      frame.includes("additional attention reports not listed individually"),
    );
    await captureFrame(
      setup,
      process.env.TUI_TOAST_CAPTURE_DIR,
      "review-attention-overflow",
    );
    act(() => {
      setup.mockInput.pressEscape();
    });
    await waitForFrame(setup, (frame) =>
      frame.includes("Attention capacity reached"),
    );
    expect(setup.captureCharFrame()).toContain("failure 20");
    await captureFrame(
      setup,
      process.env.TUI_TOAST_CAPTURE_DIR,
      "review-attention-summary",
    );
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
