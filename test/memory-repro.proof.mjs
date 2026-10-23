import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "@fungi.computer/spore/frame";
import { act, createElement } from "react";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";

import { createTuiFixture } from "./fixture.ts";

const fixture = createTuiFixture();
const providerDir = new URL(
  "../../../.botanical/tui-memory-provider/",
  import.meta.url,
);
rmSync(providerDir, { recursive: true, force: true });
mkdirSync(providerDir, { recursive: true });
const baseline = await fixture.session.read();
let writtenSteps = 0;
let readCount = 0;
fixture.session.read = async ({ before, limit = 100 } = {}) => {
  readCount += 1;
  const priorSequence =
    before === undefined ? Number.POSITIVE_INFINITY : Number(before.slice(4));
  const messages = [];
  for (
    let step = writtenSteps - 1;
    step >= 0 && messages.length < limit + 1;
    step--
  ) {
    if (step * 120 + 1 >= priorSequence) continue;
    const batch = JSON.parse(
      readFileSync(new URL(`${step}.json`, providerDir), "utf8"),
    );
    messages.unshift(
      ...batch.filter((message) => message.sequence < priorSequence),
    );
  }
  const selected = messages.slice(-limit);
  const hasMore = selected[0]?.sequence > 1;
  return {
    ...baseline,
    cursor:
      selected.at(-1) === undefined ? null : `seq-${selected.at(-1).sequence}`,
    hasMore,
    oldestCursor: hasMore ? `seq-${selected[0].sequence}` : null,
    messages: selected,
  };
};
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const commands = createWhistle();
const setup = await testRender(
  createElement(
    QueryClientProvider,
    { client },
    createElement(TuiFrame, {
      commands,
      session: fixture.session,
      initialTheme: "mocha",
    }),
  ),
  { width: 100, height: 48 },
);
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
// 5,000 results carry 80 MiB of unique text. This ceiling leaves room for
// OpenTUI, Bun's allocator, and a visible history page while rejecting the
// sustained rise seen when every result stays in the client.
const RSS_CAP_MIB = 600;
const idle = {
  queue: { state: "idle" },
  cancellationRequested: false,
  activeTool: null,
  lastModelChoiceSequence: null,
  retry: null,
  compaction: null,
};

function group(index) {
  const sequence = index * 12 + 1;
  const calls = Array.from({ length: 10 }, (_, call) => ({
    type: "toolCall",
    id: `call-${index}-${call}`,
    name: "execute",
    arguments: { code: `return ${index * 10 + call};` },
  }));
  const assistant = {
    id: `assistant-${index}`,
    commandId: null,
    sequence,
    value: {
      role: "assistant",
      api: "pi",
      provider: "fake",
      model: "fake",
      content: [{ type: "text", text: `Run ${index}.` }, ...calls],
      stopReason: "toolUse",
      timestamp: sequence,
      usage,
    },
  };
  const results = calls.map((call, result) => ({
    id: `result-${index}-${result}`,
    data: {},
    commandId: null,
    sequence: sequence + result + 1,
    value: {
      role: "toolResult",
      toolCallId: call.id,
      toolName: "execute",
      content: [
        { type: "text", text: `${index}-${result}:${"x".repeat(16384)}` },
      ],
      isError: false,
      timestamp: sequence + result + 1,
    },
  }));
  return [assistant, ...results];
}

try {
  await act(async () => setup.renderOnce());
  const steps = Number(process.env.MEMORY_STEPS ?? 50);
  let peakRss = 0;
  for (let step = 0; step < steps; step++) {
    const messages = Array.from({ length: 10 }, (_, offset) =>
      group(step * 10 + offset),
    ).flat();
    writeFileSync(
      new URL(`${step}.json`, providerDir),
      JSON.stringify(messages),
    );
    writtenSteps = step + 1;
    fixture.pushFrame({
      kind: "update",
      delivery: "live",
      cursor: `seq-${messages.at(-1).sequence}`,
      messages,
      terminals: [],
      compactions: [],
      pending: { total: 0, prompts: [], hasMore: false },
      activity: idle,
      extensions: {},
      attention: [],
    });
    await act(async () => {
      await sleep(10);
      await setup.renderOnce();
    });
    const rss = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, rss);
    const snapshot = client.getQueryData([
      "shiitake-session",
      fixture.session.address,
    ])?.snapshot;
    assert.ok(
      snapshot?.messages.length <= 400,
      "live Session page escaped its bound",
    );
    if (step % 5 === 4) {
      const queries = client.getQueryCache().getAll();
      process.stdout.write(
        `${(step + 1) * 100} rss=${Math.round(process.memoryUsage().rss / 1048576)} heap=${Math.round(process.memoryUsage().heapUsed / 1048576)} MiB messages=${snapshot?.messages.length} latest=${setup.captureCharFrame().includes(`Run ${step * 10 + 9}.`)} queries=${queries.length}\n`,
      );
    }
  }
  const latestText = `Run ${steps * 10 - 1}.`;
  for (
    let attempt = 0;
    attempt < 100 && !setup.captureCharFrame().includes(latestText);
    attempt++
  ) {
    await act(async () => {
      await sleep(10);
      await setup.renderOnce();
    });
  }
  assert.ok(
    setup.captureCharFrame().includes(latestText),
    "the live TUI did not render the newest call group",
  );
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const beforeBackscroll = readCount;
  for (let page = 0; page < 12 && readCount === beforeBackscroll; page++) {
    await act(async () => {
      setup.mockInput.pressKey("\x1b[5~");
      await sleep(10);
      await setup.renderOnce();
    });
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const renderedRuns = [
      ...setup.captureCharFrame().matchAll(/Run (\d+)\./g),
    ].map(([, index]) => Number(index));
    if (renderedRuns.some((index) => index < steps * 10 - 20)) break;
    await act(async () => {
      await sleep(10);
      await setup.renderOnce();
    });
  }
  const olderRuns = [...setup.captureCharFrame().matchAll(/Run (\d+)\./g)].map(
    ([, index]) => Number(index),
  );
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  assert.ok(
    readCount > beforeBackscroll,
    "backscroll did not refetch older history",
  );
  assert.ok(
    olderRuns.some((index) => index < steps * 10 - 20),
    "backscroll did not render the fetched history",
  );
  assert.ok(
    peakRss < RSS_CAP_MIB * 1048576,
    `TUI exceeded ${RSS_CAP_MIB} MiB RSS: ${peakRss}`,
  );
  process.stdout.write(
    `PASS ${steps * 100} tool calls, peak RSS ${Math.round(peakRss / 1048576)} MiB, older history visible\n`,
  );
} finally {
  await act(async () => setup.renderer.destroy());
  client.clear();
  commands.close();
  rmSync(providerDir, { recursive: true, force: true });
}
await fixture.waitForClose();
