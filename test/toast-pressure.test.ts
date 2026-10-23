import { afterEach, expect, jest, spyOn, test } from "bun:test";
import {
  createToastStore,
  toastQueueLimit,
} from "../src/button/toast-store.js";

afterEach(() => {
  jest.useRealTimers();
});

test("a delayed copy callback after disposal cannot resurrect a toast, listener or clock", async () => {
  const store = createToastStore();
  let finishCopy: (() => void) | undefined;
  const copied = new Promise<void>((resolve) => {
    finishCopy = resolve;
  }).then(() => {
    store.show({ variant: "info", message: "Copy request sent to terminal" });
    store.resume();
    store.activate();
    store.dismiss();
  });
  store.show({ variant: "info", message: "before teardown" });
  store.dispose();
  let publications = 0;
  const unsubscribe = store.subscribe(() => {
    publications += 1;
  });
  const clock = spyOn(globalThis, "setTimeout");
  try {
    finishCopy?.();
    await copied;
    expect(clock).not.toHaveBeenCalled();
    expect(publications).toBe(0);
    expect(store.snapshot()).toEqual({ current: undefined, pending: 0 });
  } finally {
    clock.mockRestore();
    unsubscribe();
    store.dispose();
  }
});

test("twenty info reports cannot evict a queued unresolved pane failure", () => {
  const store = createToastStore();
  try {
    store.show({ variant: "info", message: "visible" });
    store.show({
      variant: "error",
      duration: "until-dismissed",
      message: "The local shell could not be closed cleanly",
    });
    for (let index = 0; index < 20; index += 1)
      store.show({ variant: "info", message: `report ${String(index)}` });
    expect(store.snapshot().pending).toBe(toastQueueLimit);
    store.dismiss();
    expect(store.snapshot().current?.message).toBe(
      "The local shell could not be closed cleanly",
    );
    expect(store.snapshot().current?.duration).toBe("until-dismissed");
  } finally {
    store.dispose();
  }
});

test("a synchronous restart refusal becomes one persistent warning instead of escaping", () => {
  const store = createToastStore();
  let calls = 0;
  store.show({
    variant: "info",
    message: "Update installed: restart to update",
    duration: "until-dismissed",
    action: {
      label: "Restart to update",
      run: () => {
        calls += 1;
        throw new Error(
          "Local service changed during update; reopen fungi to retry",
        );
      },
    },
  });
  try {
    expect(() => {
      store.activate();
    }).not.toThrow();
    expect(store.snapshot().current).toMatchObject({
      variant: "warning",
      title: "Restart to update failed",
      message: "Local service changed during update; reopen fungi to retry",
      duration: "until-dismissed",
    });
    expect(store.snapshot().current?.action).toBeUndefined();
    store.activate();
    expect(calls).toBe(1);
  } finally {
    store.dispose();
  }
});

test("an asynchronous restart stays pending once, then exposes rejection until acknowledged", async () => {
  jest.useFakeTimers();
  const store = createToastStore();
  let refuse: ((cause: Error) => void) | undefined;
  const restart = new Promise<void>((_, reject) => {
    refuse = reject;
  });
  const settled = restart.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  let calls = 0;
  store.show({
    variant: "info",
    message: "Update installed: restart to update",
    action: {
      label: "Restart to update",
      run: () => {
        calls += 1;
        return restart;
      },
    },
  });
  store.show({ variant: "info", message: "next" });
  try {
    store.activate();
    expect(store.snapshot().current?.actionPending).toBe(true);
    store.activate();
    store.dismiss();
    store.pause();
    store.resume();
    jest.advanceTimersByTime(60_000);
    expect(calls).toBe(1);
    expect(store.snapshot().current?.message).toBe(
      "Update installed: restart to update",
    );
    refuse?.(new Error("Service restart failed"));
    expect(await settled).toBeInstanceOf(Error);
    expect(store.snapshot().current).toMatchObject({
      variant: "warning",
      title: "Restart to update failed",
      message: "Service restart failed",
      duration: "until-dismissed",
    });
    expect(store.snapshot().current?.actionPending).not.toBe(true);
    jest.advanceTimersByTime(60_000);
    expect(store.snapshot().current?.message).toBe("Service restart failed");
    store.dismiss();
    expect(store.snapshot().current?.message).toBe("next");
  } finally {
    refuse?.(new Error("test cleanup"));
    await settled;
    store.dispose();
  }
});

test("unique attention saturation retains admitted failures and exposes bounded persistent overflow", () => {
  jest.useFakeTimers();
  const store = createToastStore();
  try {
    store.show({ variant: "info", message: "visible" });
    for (let index = 0; index < toastQueueLimit + 2; index += 1)
      store.show({
        variant: "error",
        duration: "until-dismissed",
        message: `failure ${String(index)}`,
      });
    for (let index = 0; index < 40; index += 1)
      store.show({ variant: "info", message: `chatter ${String(index)}` });
    expect(store.snapshot().pending).toBe(toastQueueLimit + 1);
    expect(store.snapshot().attentionOverflow).toBe(2);
    store.dismiss();
    expect(store.snapshot().current).toMatchObject({
      title: "Attention capacity reached",
      variant: "warning",
      duration: "until-dismissed",
    });
    expect(store.snapshot().current?.message).toContain(
      "2 additional attention reports",
    );
    expect(store.snapshot().current?.message).toContain("failure 21");
    jest.advanceTimersByTime(60_000);
    expect(store.snapshot().current?.title).toBe("Attention capacity reached");
    store.dismiss();
    for (let index = 0; index < toastQueueLimit; index += 1) {
      expect(store.snapshot().current?.message).toBe(
        `failure ${String(index)}`,
      );
      store.dismiss();
    }
    expect(store.snapshot().current).toBeUndefined();
  } finally {
    store.dispose();
  }
});

test("a successful asynchronous action advances only after settling", async () => {
  const store = createToastStore();
  let finish: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.show({
    variant: "info",
    message: "Update installed",
    action: { label: "Restart to update", run: () => completed },
  });
  store.show({ variant: "info", message: "next" });
  try {
    store.activate();
    expect(store.snapshot().current?.message).toBe("Update installed");
    finish?.();
    await completed;
    expect(store.snapshot().current?.message).toBe("next");
  } finally {
    finish?.();
    store.dispose();
  }
});

test("an action rejection after teardown cannot publish a warning or create a clock", async () => {
  const store = createToastStore();
  let refuse: ((cause: Error) => void) | undefined;
  const restart = new Promise<void>((_, reject) => {
    refuse = reject;
  });
  const settled = restart.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  store.show({
    variant: "info",
    message: "Update installed",
    action: { label: "Restart to update", run: () => restart },
  });
  store.activate();
  store.dispose();
  const clock = spyOn(globalThis, "setTimeout");
  try {
    refuse?.(new Error("late failure"));
    expect(await settled).toBeInstanceOf(Error);
    expect(clock).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual({ current: undefined, pending: 0 });
  } finally {
    clock.mockRestore();
    store.dispose();
  }
});
