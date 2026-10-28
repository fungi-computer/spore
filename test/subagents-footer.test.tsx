import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import type { ParakeetSession } from "@fungi.computer/parakeet/headless";
import type {
  SessionExtensionSlots,
  SessionFrame,
} from "@fungi.computer/shiitake/client";
import * as Schema from "effect/Schema";
import type { Json } from "@fungi.computer/shiitake/extensions";
import subagentsClient from "@fungi.computer/shiitake-extensions/subagents/client";
import {
  subagentsContract,
  SubagentsProjection,
} from "@fungi.computer/shiitake-extensions/subagents";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";
import { observeCommandExecutions } from "./command-selection.js";

const defaultAgents: SubagentsProjection["agents"] = [
  {
    agentId: "agent-scout",
    name: "Scout",
    sessionId: "scout-main",
    state: "working",
  },
  {
    agentId: "agent-critic",
    name: "Critic",
    sessionId: "critic-main",
    state: "needs_you",
    attention: "Approve files.write",
  },
  {
    agentId: "agent-scribe",
    name: "Scribe",
    sessionId: "scribe-main",
    state: "idle",
  },
  {
    agentId: "agent-fresh",
    name: "Fresh",
    sessionId: null,
    state: "idle",
  },
];

/** The host's slot, with the `/agents` command it advertises. */
const slotsFor = (
  expanded: boolean,
  agents: SubagentsProjection["agents"] = defaultAgents,
): SessionExtensionSlots => ({
  [subagentsContract.id]: {
    status: "running",
    revision: "sha256:subagents-fixture",
    catalog: {
      protocol: "whistle.catalog/v1",
      commands: [
        {
          id: "agents",
          title: "Agents",
          category: "Conversation",
          projections: { slash: { aliases: ["agents"] } },
        },
        {
          id: "answerChild",
          title: "Answer a sub-agent",
          category: "Conversation",
        },
      ],
    },
    value: Schema.encodeSync(SubagentsProjection)({
      agents,
      more: 0,
      expanded,
    }),
  },
});
const slots = slotsFor(true);

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  test(`sub-agent rows show live status and a click opens one beside the parent (${String(width)}×${String(height)})`, async () => {
    notifyManager.setScheduler(queueMicrotask);
    const fixture = createTuiFixture();
    const session: ParakeetSession = {
      ...fixture.session,
      read: async (input) => ({
        ...(await fixture.session.read(input)),
        extensions: slots,
      }),
      watch: async (input) => {
        const watch = await fixture.session.watch(input);
        return {
          ...watch,
          snapshot: { ...watch.snapshot, extensions: slots },
        };
      },
    };
    const opened: unknown[] = [];
    const peer = createTuiFixture();
    const peerWatching = Promise.withResolvers<undefined>();
    const commands = createWhistle();
    const query = createQueryClient();
    const setup = await testRender(
      <QueryClientProvider client={query}>
        <TuiFrame
          initialTheme="mocha"
          session={session}
          clients={[subagentsClient]}
          commands={commands}
          acquireSession={(target) => {
            opened.push(target);
            return Promise.resolve({
              session: {
                ...peer.session,
                address: "fixture://agent-critic/critic-main",
                watch: async (input) => {
                  const watch = await peer.session.watch(input);
                  peerWatching.resolve(undefined);
                  return watch;
                },
              },
              context: { agentName: "Critic" },
              close: () => Promise.resolve(),
            });
          }}
        />
      </QueryClientProvider>,
      { width, height },
    );
    const frame = async (text: string) => {
      try {
        await act(async () =>
          setup.waitForFrame((value) => value.includes(text)),
        );
      } catch (cause) {
        throw new Error(`Expected native frame: ${text}`, { cause });
      }
    };
    const output = process.env.TUI_SUBAGENTS_CAPTURE_DIR;
    try {
      await frame("Scout · working");
      const before = setup.captureCharFrame();
      expect(before).toContain("Critic · needs you · Approve files.write");
      expect(before).toContain("Scribe · idle");
      expect(before).toContain("Fresh · idle · not messaged yet");
      await captureFrame(setup, output, `subagents-footer-${String(width)}`);
      // A created, never-messaged Agent has no conversation to open.
      const fresh = before
        .split("\n")
        .findIndex((line) => line.includes("Fresh · idle"));
      await act(async () => {
        await setup.mockMouse.click(10, fresh);
      });
      await act(async () => setup.renderOnce());
      expect(opened).toEqual([]);
      const critic = before
        .split("\n")
        .findIndex((line) => line.includes("Critic · needs you"));
      await act(async () => {
        await setup.mockMouse.click(10, critic);
        await peerWatching.promise;
      });
      expect(peer.watchCalls()).toBe(1);
      expect(opened).toEqual([
        { agentId: "agent-critic", sessionId: "critic-main" },
      ]);
      await act(async () => setup.renderOnce());
      // The parent stays open in its own pane beside the child.
      expect(fixture.closeCalls()).toBe(0);
      expect(setup.captureCharFrame()).toContain("Scout · working");
      await captureFrame(setup, output, `subagents-beside-${String(width)}`);
    } finally {
      await destroyTestRenderer(setup);
      commands.close();
      query.clear();
      await fixture.waitForClose();
      if (peer.watchCalls() > 0) await peer.waitForClose();
      notifyManager.setScheduler(defaultScheduler);
    }
  });
}

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  test(`the footer starts collapsed and /agents expands it (${String(width)}×${String(height)})`, async () => {
    notifyManager.setScheduler(queueMicrotask);
    const fixture = createTuiFixture();
    let expanded = false;
    const calls: string[] = [];
    let update: SessionFrame | undefined;
    const session: ParakeetSession = {
      ...fixture.session,
      read: async (input) => ({
        ...(await fixture.session.read(input)),
        extensions: slotsFor(expanded),
      }),
      watch: async (input) => {
        const watch = await fixture.session.watch(input);
        return {
          ...watch,
          snapshot: { ...watch.snapshot, extensions: slotsFor(expanded) },
        };
      },
      extension: () => ({
        call: async (name) => {
          calls.push(name);
          expanded = !expanded;
          const snapshot = await fixture.session.read();
          update = {
            kind: "update",
            delivery: "live",
            cursor: `agents-${String(calls.length)}`,
            messages: [],
            terminals: [],
            activity: snapshot.activity,
            pending: snapshot.pending,
            attention: snapshot.attention,
            extensions: slotsFor(expanded),
          };
          return { type: "done" };
        },
      }),
    };
    const { commands, nextExecution } =
      observeCommandExecutions(createWhistle());
    const query = createQueryClient();
    const setup = await testRender(
      <QueryClientProvider client={query}>
        <TuiFrame
          initialTheme="mocha"
          session={session}
          clients={[subagentsClient]}
          commands={commands}
        />
      </QueryClientProvider>,
      { width, height, kittyKeyboard: true },
    );
    const frame = async (ready: (value: string) => boolean, label: string) => {
      try {
        await act(async () => setup.waitForFrame(ready));
      } catch (cause) {
        throw new Error(`Expected native frame: ${label}`, { cause });
      }
    };
    const toastCorner = () =>
      setup
        .captureCharFrame()
        .split("\n")
        .slice(0, 8)
        .map((line) => line.slice(60))
        .join("")
        .trim();
    const run = async () => {
      const completed = nextExecution("agents");
      await act(async () => setup.mockInput.typeText("/agents"));
      act(() => {
        setup.mockInput.pressKey("RETURN");
      });
      await act(async () => {
        await completed;
        // The host publishes after the command's own reply, under test control.
        if (update === undefined)
          throw new Error("The /agents update is absent");
        fixture.pushFrame(update);
        update = undefined;
        await setup.renderOnce();
      });
    };
    try {
      await frame(
        (value) => value.includes("4 sub-agents · 1 working · 1 needs you"),
        "collapsed on first render",
      );
      expect(setup.captureCharFrame()).not.toContain("Scribe · idle");
      // The collapsed summary keeps live status without listing every Agent.
      expect(toastCorner()).toBe("");
      await run();
      await frame(
        (value) => value.includes("Scribe · idle"),
        "rows listed after /agents",
      );
      expect(setup.captureCharFrame()).not.toContain("4 sub-agents");
      expect(toastCorner()).toBe("");
      expect(calls).toEqual(["agents"]);
      await run();
      await frame(
        (value) => value.includes("4 sub-agents · 1 working · 1 needs you"),
        "collapsed after a second /agents",
      );
      expect(calls).toEqual(["agents", "agents"]);
    } finally {
      await destroyTestRenderer(setup);
      commands.close();
      query.clear();
      await fixture.waitForClose();
      notifyManager.setScheduler(defaultScheduler);
    }
  });
}

const calmScout: SubagentsProjection["agents"][number] = {
  agentId: "agent-scout",
  name: "Scout",
  sessionId: "scout-main",
  state: "waiting_on_agent",
  waitingOn: "Shiitake",
  attention: "Branch",
};
const escalatedCritic: SubagentsProjection["agents"][number] = {
  agentId: "agent-critic",
  name: "Critic",
  sessionId: "critic-main",
  state: "needs_you",
  attention: "Price",
  ask: {
    askId: "ask-price",
    questions: [
      {
        id: "price",
        header: "Price",
        question: "Price: $0 or $50?",
        options: [
          { label: "$0", description: "Free" },
          { label: "$50", description: "Paid" },
        ],
      },
    ],
  },
};

/** Render the parent footer over these sub-agents and capture what it shows. */
async function footerFor(
  agents: SubagentsProjection["agents"],
  expanded: boolean,
  captureName?: string,
) {
  notifyManager.setScheduler(queueMicrotask);
  const fixture = createTuiFixture();
  const slots = slotsFor(expanded, agents);
  const calls: Json[] = [];
  const session: ParakeetSession = {
    ...fixture.session,
    read: async (input) => ({
      ...(await fixture.session.read(input)),
      extensions: slots,
    }),
    watch: async (input) => {
      const watch = await fixture.session.watch(input);
      return { ...watch, snapshot: { ...watch.snapshot, extensions: slots } };
    },
    // The host's answerChild opens the child's question as a composer decision.
    extension: () => ({
      call: (_name, input): Promise<Json> => {
        calls.push(input);
        const { askId } = Schema.decodeUnknownSync(
          Schema.Struct({ askId: Schema.String }),
        )(input);
        const child = agents.find((agent) => agent.ask?.askId === askId);
        const question = child?.ask?.questions[0];
        if (child?.ask === undefined || question === undefined)
          return Promise.reject(
            new Error("Fixture expects a listed child question"),
          );
        return Promise.resolve({
          type: "prompt",
          prompt: {
            type: "decision",
            message: question.question,
            options: question.options.map((option) => ({
              value: option.label,
              label: option.label,
              description: option.description,
            })),
          },
          next: {
            arguments: {
              stage: "decision",
              agentId: child.agentId,
              sessionId: child.sessionId ?? "",
              askId: child.ask.askId,
              requestId: "request-child",
              index: 0,
              answers: {},
            },
            answer: "answer",
          },
        });
      },
    }),
  };
  const commands = createWhistle();
  const query = createQueryClient();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        initialTheme="mocha"
        session={session}
        clients={[subagentsClient]}
        commands={commands}
      />
    </QueryClientProvider>,
    { width: 120, height: 36 },
  );
  const ready = expanded ? "Scout" : "sub-agent";
  await act(async () => setup.waitForFrame((value) => value.includes(ready)));
  const text = setup.captureCharFrame();
  if (captureName !== undefined)
    await captureFrame(
      setup,
      process.env.TUI_SUBAGENTS_CAPTURE_DIR,
      captureName,
    );
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const ink = (needle: string) =>
    spans
      .find((span) => span.text.includes(needle))
      ?.fg.toInts()
      .join(",");
  return {
    text,
    ink,
    calls,
    frame: async (needle: string) =>
      act(async () => setup.waitForFrame((value) => value.includes(needle))),
    close: async () => {
      await destroyTestRenderer(setup);
      commands.close();
      query.clear();
      await fixture.waitForClose();
      notifyManager.setScheduler(defaultScheduler);
    },
  };
}

test("a child waiting on its parent reads calm and never puts waiting on you in this footer", async () => {
  const footer = await footerFor([calmScout], true, "routed-calm");
  try {
    expect(footer.text).toContain("Scout · waiting on Shiitake");
    expect(footer.text).toContain("Branch");
    expect(footer.text).not.toContain("waiting on you");
    expect(footer.text).not.toContain("needs you");
  } finally {
    await footer.close();
  }
});

test("an escalated question shows inline with Answer, and only then is this conversation waiting on you", async () => {
  const footer = await footerFor(
    [calmScout, escalatedCritic],
    true,
    "escalated-needs-you",
  );
  try {
    // The question itself takes over the composer as a decision; the calm
    // child's question never does.
    const taken = await footer.frame("1. $0");
    expect(taken).toContain("Price: $0 or $50?");
    expect(taken).toContain("Scout · waiting on Shiitake");
    expect(taken).toContain("waiting on you");
    expect(footer.calls).toEqual([
      { agentId: "agent-critic", sessionId: "critic-main", askId: "ask-price" },
    ]);
  } finally {
    await footer.close();
  }
});

test("the collapsed summary is amber only for needs you", async () => {
  const calm = await footerFor([calmScout], false);
  const needing = await footerFor([calmScout, escalatedCritic], false);
  try {
    expect(calm.text).toContain("1 sub-agent · 1 waiting on Shiitake");
    expect(needing.text).toContain(
      "2 sub-agents · 1 waiting on Shiitake · 1 needs you",
    );
    expect(calm.ink("sub-agent")).toBeDefined();
    expect(calm.ink("sub-agent")).not.toBe(needing.ink("sub-agents"));
  } finally {
    await calm.close();
    await needing.close();
  }
});
