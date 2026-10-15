import { expect, test } from "bun:test";
import { killSessionProcesses } from "../src/button/local-terminal-processes.js";

test("session cleanup stops when no processes match", async () => {
  let attempts = 0;
  await killSessionProcesses(() => Promise.resolve(++attempts === 3 ? 1 : 0));
  expect(attempts).toBe(3);
});

test("session cleanup refuses an endlessly replenished session after eight passes", async () => {
  let attempts = 0;
  const result = await killSessionProcesses(() => {
    attempts += 1;
    if (attempts > 8) throw new Error("Kill utility exceeded the safety bound");
    return Promise.resolve(0);
  }).catch((cause: unknown) => cause);
  expect(result).toMatchObject({
    message: "Local terminal process cleanup did not settle",
  });
  expect(attempts).toBe(8);
});

test("session cleanup reports a failed utility immediately", async () => {
  let attempts = 0;
  const result = await killSessionProcesses(() => {
    attempts += 1;
    return Promise.resolve(2);
  }).catch((cause: unknown) => cause);
  expect(result).toMatchObject({
    message: "Local terminal process cleanup did not settle",
  });
  expect(attempts).toBe(1);
});
