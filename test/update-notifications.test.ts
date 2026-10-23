import { expect, spyOn, test } from "bun:test";
import {
  startUpdateNotifications,
  watchFungiUpdates,
  type UpdateNotification,
} from "../src/update-notifications.js";

test("source checkouts do not schedule an installed-release watcher", () => {
  const launcher = process.env.FUNGI_LAUNCHER;
  const schedule = spyOn(globalThis, "setInterval");
  try {
    for (const source of [undefined, "/fixture/cli.tsx"]) {
      if (source === undefined) delete process.env.FUNGI_LAUNCHER;
      else process.env.FUNGI_LAUNCHER = source;
      const stop = watchFungiUpdates(() => {
        throw new Error("Source checkouts must not notify");
      });
      stop();
    }
    expect(schedule).not.toHaveBeenCalled();
  } finally {
    schedule.mockRestore();
    if (launcher === undefined) delete process.env.FUNGI_LAUNCHER;
    else process.env.FUNGI_LAUNCHER = launcher;
  }
});

test("off performs no registry or installed-version lookup", async () => {
  let calls = 0;
  const stop = startUpdateNotifications({
    running: "1.0.0",
    policy: () => Promise.resolve("off"),
    installed: () => {
      calls++;
      return Promise.resolve("2.0.0");
    },
    registry: () => {
      calls++;
      return Promise.resolve("2.0.0");
    },
    notify: () => {
      throw new Error("off must not notify");
    },
    reportFailure: () => {
      throw new Error("off must not fail");
    },
  });
  await Bun.sleep(10);
  stop();
  expect(calls).toBe(0);
});

test("launch never waits for the registry and notices each version once", async () => {
  let tick: (() => void) | undefined;
  let installed = "1.0.0";
  let latest = "1.1.0";
  const notices: UpdateNotification[] = [];
  const failures: unknown[] = [];
  let resolve: ((version: string) => void) | undefined;
  let registry = () =>
    new Promise<string>((done) => {
      resolve = done;
    });
  const stop = startUpdateNotifications({
    running: "1.0.0",
    policy: () => Promise.resolve("notify"),
    installed: () => Promise.resolve(installed),
    registry: () => registry(),
    notify: (notice) => notices.push(notice),
    reportFailure: (cause) => failures.push(cause),
    schedule: (callback, milliseconds) => {
      expect(milliseconds).toBe(600_000);
      tick = callback;
      return () => {
        tick = undefined;
      };
    },
  });
  await Bun.sleep(5);
  expect(notices).toEqual([]);
  resolve?.(latest);
  await Bun.sleep(5);
  expect(notices).toEqual([{ kind: "available", version: "1.1.0" }]);
  registry = () => Promise.resolve(latest);
  tick?.();
  await Bun.sleep(5);
  expect(notices).toHaveLength(1);
  installed = latest;
  tick?.();
  await Bun.sleep(5);
  expect(notices.at(-1)).toEqual({ kind: "restart", version: "1.1.0" });
  tick?.();
  await Bun.sleep(5);
  expect(notices).toHaveLength(2);
  latest = "1.2.0";
  tick?.();
  await Bun.sleep(5);
  expect(notices.at(-1)).toEqual({ kind: "available", version: "1.2.0" });
  registry = () => Promise.reject(new Error("offline"));
  tick?.();
  await Bun.sleep(5);
  expect(failures).toHaveLength(1);
  stop();
  expect(tick).toBeUndefined();
});

test("closing the terminal cancels its check and ignores a late registry response", async () => {
  let finish: ((version: string) => void) | undefined;
  let signal: AbortSignal | undefined;
  let requests = 0;
  let tick: (() => void) | undefined;
  const notices: UpdateNotification[] = [];
  const stop = startUpdateNotifications({
    running: "1.0.0",
    policy: () => Promise.resolve("notify"),
    installed: () => Promise.resolve("1.0.0"),
    registry: (requestSignal) => {
      requests++;
      signal = requestSignal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
    notify: (notice) => notices.push(notice),
    reportFailure: (cause) => {
      throw cause;
    },
    schedule: (callback) => {
      tick = callback;
      return () => {
        tick = undefined;
      };
    },
  });
  await Bun.sleep(5);
  tick?.();
  await Bun.sleep(5);
  expect(requests).toBe(1);
  stop();
  expect(signal?.aborted).toBe(true);
  finish?.("2.0.0");
  await Bun.sleep(5);
  expect(notices).toEqual([]);
});
