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

const questionExtensionId = "botanical-session-question";
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
    toolOutput: [],
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
      withdraw: () => Promise.resolve({ status: "unknown" }),
      address: "fixture://session",
      latestPending: () =>
        Promise.reject(
          new Error("Pending lookup is unused in this observation proof"),
        ),
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

test("Herdr activity only blocks for human-needed attention, not a person's paused goal", async () => {
  const fake = fixture();
  const queryClient = createQueryClient();
  const snapshot = await fake.session.read();
  const states: string[] = [];
  const detach = subscribeSessionActivity(
    queryClient,
    fake.session,
    (activity) => states.push(activity.state),
    questionExtensionId,
  );
  const publish = (attention: SessionSnapshot["attention"]) =>
    queryClient.setQueryData(sessionQueryOptions(fake.session).queryKey, {
      observation: "live",
      snapshot: { ...snapshot, attention },
      latestPrompt: undefined,
    });
  const item = {
    id: "paused-goal",
    extensionId: "botanical-session-goal",
    summary: "The goal is paused",
    since: 1,
  };
  try {
    // An informational item does not ask a person to act.
    publish([{ ...item, kind: "goal" }]);
    assert.equal(states.at(-1), "idle");
    publish([{ ...item, kind: "goal-blocked" }]);
    assert.equal(states.at(-1), "blocked");
    publish([{ ...item, kind: "goal-stalled" }]);
    assert.equal(states.at(-1), "blocked");
    publish([
      {
        ...item,
        extensionId: questionExtensionId,
        kind: "question",
      },
    ]);
    assert.equal(states.at(-1), "blocked");
    publish([]);
    assert.equal(states.at(-1), "idle");
    queryClient.setQueryData(sessionQueryOptions(fake.session).queryKey, {
      observation: "live",
      snapshot: {
        ...snapshot,
        attention: [{ ...item, kind: "note" }],
        activity: runningActivity(),
      },
      latestPrompt: undefined,
    });
    assert.equal(states.at(-1), "working");
  } finally {
    detach();
    queryClient.clear();
  }
});

test("client activity shares chat observation and reports unknown without closing chat", async () => {
  const fake = fixture();
  const queryClient = createQueryClient();
  const states: string[] = [];
  const detach = subscribeSessionActivity(
    queryClient,
    fake.session,
    (state) => {
      if (states.at(-1) !== state.state) states.push(state.state);
    },
    questionExtensionId,
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
    questionExtensionId,
  );
  const first = activity[Symbol.asyncIterator]();
  const second = activity[Symbol.asyncIterator]();
  try {
    assert.deepEqual(await first.next(), {
      done: false,
      value: { state: "idle" },
    });
    assert.deepEqual(await second.next(), {
      done: false,
      value: { state: "idle" },
    });
    publish({
      ...snapshot,
      activity: runningActivity(),
    });
    await tick();
    assert.deepEqual(await first.next(), {
      done: false,
      value: { state: "working" },
    });
    // The slow iterator leaves working unread; idle then replaces that one slot.
    publish(snapshot);
    await tick();
    assert.deepEqual(await first.next(), {
      done: false,
      value: { state: "idle" },
    });
    assert.deepEqual(await second.next(), {
      done: false,
      value: { state: "idle" },
    });
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

test("an open agent question reports blocked mid-turn and parked, and answering restores activity", async () => {
  const fake = fixture();
  const queryClient = createQueryClient();
  const snapshot = await fake.session.read();
  const question = {
    id: "q1",
    kind: "question",
    summary: "Scope",
    since: 1,
    extensionId: questionExtensionId,
  };
  const publish = (next: SessionSnapshot) =>
    queryClient.setQueryData(sessionQueryOptions(fake.session).queryKey, {
      observation: "live",
      snapshot: next,
      latestPrompt: undefined,
    });
  const states: string[] = [];
  const headers: (string | undefined)[] = [];
  const detach = subscribeSessionActivity(
    queryClient,
    fake.session,
    (state) => {
      if (states.at(-1) !== state.state) states.push(state.state);
      if (state.state === "blocked") headers.push(state.header);
    },
    questionExtensionId,
  );
  try {
    publish(snapshot);
    publish({ ...snapshot, activity: runningActivity() });
    publish({
      ...snapshot,
      activity: runningActivity(),
      attention: [question],
    });
    publish({ ...snapshot, activity: runningActivity() });
    publish({ ...snapshot, attention: [question] });
    publish(snapshot);
    assert.deepEqual(states, [
      "unknown",
      "idle",
      "working",
      "blocked",
      "working",
      "blocked",
      "idle",
    ]);
    // Only the attention header is observed, never a question body.
    assert.deepEqual(headers, ["Scope", "Scope"]);
  } finally {
    detach();
    queryClient.clear();
  }
});

test("only the question extension's headers reach the activity stream", async () => {
  const fake = fixture();
  const queryClient = createQueryClient();
  const controller = new AbortController();
  const snapshot = await fake.session.read();
  const publish = (next: SessionSnapshot) =>
    queryClient.setQueryData(sessionQueryOptions(fake.session).queryKey, {
      observation: "live",
      snapshot: next,
      latestPrompt: undefined,
    });
  const item = {
    id: "a1",
    kind: "question",
    summary: "Scope",
    since: 1,
    extensionId: questionExtensionId,
  };
  publish({ ...snapshot, attention: [item] });
  const iterator = clientActivity(
    fake.session,
    queryClient,
    undefined,
    controller.signal,
    questionExtensionId,
  )[Symbol.asyncIterator]();
  try {
    assert.deepEqual(await iterator.next(), {
      done: false,
      value: { state: "blocked", header: "Scope" },
    });
    publish({
      ...snapshot,
      attention: [
        { ...item, extensionId: "other", kind: "note", summary: "free text" },
      ],
    });
    await tick();
    assert.deepEqual(await iterator.next(), {
      done: false,
      value: { state: "idle" },
    });
  } finally {
    controller.abort();
    await iterator.return?.();
    queryClient.clear();
  }
});
