import { expect, test } from "bun:test";
import { admitTerminalTermination } from "../src/panes/terminal/quit.js";
import type { ToastInput } from "../src/button/index.js";

test("failed job inspection keeps the shell open and explains the refused quit", async () => {
  const notices: ToastInput[] = [];
  let confirmations = 0;
  const allowed = await admitTerminalTermination(
    () => Promise.reject(new Error("ps failed")),
    () => {
      confirmations += 1;
      return Promise.resolve(true);
    },
    (notice) => {
      notices.push(notice);
    },
  );
  expect(allowed).toBe(false);
  expect(confirmations).toBe(0);
  expect(notices).toEqual([
    {
      variant: "error",
      duration: "until-dismissed",
      message:
        "Could not check shell jobs. Shells are still running; try again.",
    },
  ]);
});

test("idle shells quit without a question; running jobs require consent", async () => {
  const toast = () => {
    throw new Error("Unexpected notice");
  };
  const confirm = () => Promise.resolve(false);
  expect(
    await admitTerminalTermination(
      () => Promise.resolve(false),
      confirm,
      toast,
    ),
  ).toBe(true);
  expect(
    await admitTerminalTermination(() => Promise.resolve(true), confirm, toast),
  ).toBe(false);
  expect(
    await admitTerminalTermination(
      () => Promise.resolve(true),
      () => Promise.resolve(true),
      toast,
    ),
  ).toBe(true);
});
