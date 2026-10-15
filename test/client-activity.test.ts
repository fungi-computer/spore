import {
  idleActivity,
  runningActivity,
} from "@fungi.computer/parakeet-testing";
import assert from "node:assert/strict";
import { test } from "bun:test";
import type {
  SessionFrame,
  SessionSnapshot,
  ShiitakeSession,
} from "@fungi.computer/shiitake";
import { QueryObserver } from "@tanstack/query-core";
import { createQueryClient } from "@fungi.computer/agar/query";
import { clientActivity } from "../src/client-extensions.js";
import {
  sessionQueryOptions,
  subscribeSessionActivity,
} from "@fungi.computer/parakeet/headless";

type Fixture = {
  session: ShiitakeSession;
  push: (frame: SessionFrame) => void;
  closes: () => number;
};
function fixture(): Fixture {
  const frames: SessionFrame[] = [];
  const waiters: ((result: IteratorResult<SessionFrame>) => void)[] = [];
  let ended = false;
  let closes = 0;
  const snapshot: SessionSnapshot = {
    pending: { total: 0, prompts: [], hasMore: false },
    cursor: null,
    hasMore: false,
    messages: [],
    progress: null,
    sessionId: "fixture",
    activity: idleActivity,
    terminals: [],
    extensions: {},
    attention: [],
  };
  const changes: AsyncIterable<SessionFrame> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const frame = frames.shift();
        if (frame !== undefined)
          return Promise.resolve({ done: false, value: frame });
        if (ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => waiters.push(resolve));
      },
    }),
  };
  return {
    push: (frame) => {
      const resolve = waiters.shift();
      if (resolve === undefined) frames.push(frame);
      else resolve({ done: false, value: frame });
    },
    session: {
      address: "fixture://session",
      extension: () => ({
        call: () => Promise.reject(new Error("Extensions are unused here")),
      }),
      abort: () => Promise.resolve(),
      send: () =>
        Promise.resolve({ status: "accepted" as const, commandId: "unused" }),
      cancel: () =>
        Promise.resolve({ status: "accepted" as const, commandId: "unused" }),
      command: (): Promise<never> =>
        Promise.reject(
          new Error("Commands are unused in this observation proof"),
        ),
      modelPreference: {
        read: () => Promise.resolve(null),
        set: () => Promise.resolve(),
      },
      read: () => Promise.resolve(snapshot),
      subscribe: () => changes,
      watch: () =>
        Promise.resolve({
          snapshot,
          changes,
          close: () => {
            ended = true;
            closes += 1;
            for (const resolve of waiters.splice(0))
              resolve({ done: true, value: undefined });
            return Promise.resolve();
          },
        }),
    },
    closes: () => closes,
  };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("client activity shares chat observation and reports unknown without closing chat", async () => {
  const fake = fixture();
  const queryClient = createQueryClient();
  const states: string[] = [];
  const detach = subscribeSessionActivity(
    queryClient,
    fake.session,
    (state) => {
      if (states.at(-1) !== state) states.push(state);
    },
  );
  const chat = new QueryObserver(
    queryClient,
    sessionQueryOptions(fake.session),
  );
  const unsubscribe = chat.subscribe(() => undefined);
  try {
    await tick();
    fake.push({
      pending: { total: 0, prompts: [], hasMore: false },
      kind: "update",
      delivery: "live",
      cursor: "1",
      messages: [],
      terminals: [],
      activity: runningActivity(),
      extensions: {},
      attention: [],
    });
    await tick();
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: sessionQueryOptions(fake.session).queryKey });
    assert.ok(query);
    query.setState({ status: "error", error: new Error("observation failed") });
    await tick();
    detach();
    assert.deepEqual(states, ["unknown", "idle", "working", "unknown"]);
    assert.equal(fake.closes(), 0);
  } finally {
    detach();
    unsubscribe();
    await queryClient.cancelQueries();
    queryClient.clear();
  }
  assert.equal(fake.closes(), 1);
});

test("public activity gives independent latest-value subscriptions and ends at detach", async () => {
  const fake = fixture();
  const queryClient = createQueryClient();
  const controller = new AbortController();
  const snapshot = await fake.session.read();
  const publish = (snapshot: SessionSnapshot) =>
    queryClient.setQueryData(sessionQueryOptions(fake.session).queryKey, {
      observation: "live",
      snapshot,
      latestPrompt: undefined,
    });
  publish(snapshot);
  const activity = clientActivity(
    fake.session,
    queryClient,
    undefined,
    controller.signal,
  );
  const first = activity[Symbol.asyncIterator]();
  const second = activity[Symbol.asyncIterator]();
  try {
    assert.deepEqual(await first.next(), { done: false, value: "idle" });
    assert.deepEqual(await second.next(), { done: false, value: "idle" });
    publish({
      ...snapshot,
      activity: runningActivity(),
    });
    await tick();
    assert.deepEqual(await first.next(), { done: false, value: "working" });
    // The slow iterator leaves working unread; idle then replaces that one slot.
    publish(snapshot);
    await tick();
    assert.deepEqual(await first.next(), { done: false, value: "idle" });
    assert.deepEqual(await second.next(), { done: false, value: "idle" });
    // Buffered work is discarded when the borrowed selected-Session scope detaches.
    publish({
      ...snapshot,
      activity: runningActivity(),
    });
    await tick();
    controller.abort();
    assert.equal((await first.next()).done, true);
    assert.equal((await second.next()).done, true);
    assert.equal(fake.closes(), 0);
  } finally {
    controller.abort();
    await first.return?.();
    await second.return?.();
    queryClient.clear();
  }
});
