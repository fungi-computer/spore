import { expect, test } from "bun:test";
import {
  createUpdateDraftCheckpointBarrier,
  type UpdateDraftCheckpoint,
} from "../src/update-restart.js";

test("restart refuses an empty or not-yet-mounted composer set", () => {
  const barrier = createUpdateDraftCheckpointBarrier();
  expect(() => {
    barrier.checkpoint([]);
  }).toThrow("No selected Session");
  expect(() => {
    barrier.checkpoint(["session:a"]);
  }).toThrow("not ready");
});

test("the last synchronous step before handoff invokes live owner callbacks, including other panes", () => {
  const barrier = createUpdateDraftCheckpointBarrier();
  const events: string[] = [];
  let latest = "old";
  barrier.register("session:a", () => {
    events.push(`saved ${latest}`);
    return { status: "saved" };
  });
  barrier.register("session:b", () => {
    events.push("saved other pane");
    return { status: "saved" };
  });
  // A version/activity lookup may have been in flight before this barrier.
  latest = "newer";
  barrier.checkpoint(["session:a"]);
  events.push("launcher handoff");
  expect(events).toEqual([
    "saved newer",
    "saved other pane",
    "launcher handoff",
  ]);
});

test("one failed owner checkpoint prevents handoff and preserves its reason", () => {
  const barrier = createUpdateDraftCheckpointBarrier();
  let handedOff = false;
  barrier.register("session:a", () => ({ status: "saved" }));
  barrier.register("session:b", () => ({
    status: "failed",
    reason: "Journal directory is not writable",
  }));
  expect(() => {
    barrier.checkpoint(["session:a", "session:b"]);
    handedOff = true;
  }).toThrow("Restart cancelled: Journal directory is not writable");
  expect(handedOff).toBe(false);
});

test("unmount removes only its own registration, even for the same callback", () => {
  const barrier = createUpdateDraftCheckpointBarrier();
  let calls = 0;
  const checkpoint: UpdateDraftCheckpoint = () => {
    calls++;
    return { status: "saved" };
  };
  const releaseFirst = barrier.register("session:a", checkpoint);
  const releaseSecond = barrier.register("session:a", checkpoint);
  releaseFirst();
  releaseFirst();
  barrier.checkpoint(["session:a"]);
  expect(calls).toBe(1);
  releaseSecond();
  expect(() => {
    barrier.checkpoint(["session:a"]);
  }).toThrow("not ready");
  const releaseThird = barrier.register("session:a", checkpoint);
  releaseFirst();
  barrier.checkpoint(["session:a"]);
  expect(calls).toBe(2);
  releaseThird();
});
