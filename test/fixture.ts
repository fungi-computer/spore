import type {
  ParakeetSession,
  ParakeetDraftIdentity,
} from "@fungi.computer/parakeet/headless";
import type {
  AbortCommand,
  Accepted,
  BranchCommand,
  OperatorCommand,
  TitleCommand,
  CancelCommand,
  CancelResult,
  ForkedSession,
  ForkCommand,
  CompactCommand,
  PromptCommand,
  SessionCommand,
  SessionCommandHandler,
  SessionExtensionSlots,
  SessionFrame,
  SessionMessage,
  SessionSnapshot,
  SessionWatch,
} from "@fungi.computer/shiitake/client";
import type { Json } from "@fungi.computer/shiitake/extensions";
import {
  gardenCall,
  gardenExtensionId,
  gardenSlots,
  idleActivity,
  queuedActivity,
  runningActivity,
} from "@fungi.computer/parakeet-testing";
import {
  Goal,
  GoalProjection,
  goalContract,
} from "@fungi.computer/shiitake-extensions/goal";
import {
  Loop,
  LoopProjection,
  loopContract,
} from "@fungi.computer/shiitake-extensions/loop";
import {
  Plan,
  PlanProjection,
  planContract,
} from "@fungi.computer/shiitake-extensions/plan";
import * as Schema from "effect/Schema";
import { goalCatalog } from "@fungi.computer/shiitake-extensions/goal/host";
import { loopCatalog } from "@fungi.computer/shiitake-extensions/loop/host";
import goalClient from "@fungi.computer/shiitake-extensions/goal/client";
import loopClient from "@fungi.computer/shiitake-extensions/loop/client";
import planClient from "@fungi.computer/shiitake-extensions/plan/client";

export const fixtureClients = [goalClient, loopClient, planClient];
const emptyHistory = { events: [], nextSequence: 1, omitted: 0 };
const encodeGoalProjection = Schema.encodeUnknownSync(GoalProjection);
const encodeLoopProjection = Schema.encodeUnknownSync(LoopProjection);
const encodePlanProjection = Schema.encodeUnknownSync(PlanProjection);
const decodeGoalCommand = Schema.decodeUnknownSync(
  goalContract.commands.goal.input,
);
const decodeLoopCommand = Schema.decodeUnknownSync(
  loopContract.commands.loop.input,
);
const encodeCatalog = Schema.encodeUnknownSync(Schema.Json);

const encodeGoal = Schema.encodeUnknownSync(Goal);
/** When fixture goals start: 14:02 UTC, shown in the viewer's local time. */
export const fixtureGoalStartedAt = Date.parse("2026-10-18T14:02:00.000Z");
const encodeLoop = Schema.encodeUnknownSync(Loop);
const decodeGoalSet = Schema.decodeUnknownSync(goalContract.commands.set.input);
const decodeLoopStart = Schema.decodeUnknownSync(
  Schema.Struct({ prompt: Schema.String, requestId: Schema.String }),
);

type FrameQueue = Readonly<{
  changes: AsyncIterable<SessionFrame>;
  close: () => void;
  push: (frame: SessionFrame) => void;
}>;

function frameQueue(): FrameQueue {
  const queued: SessionFrame[] = [];
  const waiting: ((result: IteratorResult<SessionFrame>) => void)[] = [];
  let closed = false;
  const settle = (): void => {
    while (waiting.length > 0) {
      const resolve = waiting.shift();
      resolve?.({ done: true, value: undefined });
    }
  };
  const iterator: AsyncIterator<SessionFrame> = {
    next: () => {
      const frame = queued.shift();
      if (frame !== undefined)
        return Promise.resolve({ done: false, value: frame });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    return: () => {
      closed = true;
      settle();
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return {
    changes: { [Symbol.asyncIterator]: () => iterator },
    close: () => {
      closed = true;
      settle();
    },
    push: (frame) => {
      if (closed) return;
      const resolve = waiting.shift();
      if (resolve === undefined) queued.push(frame);
      else resolve({ done: false, value: frame });
    },
  };
}

export type TuiFixture = Readonly<{
  identity: ParakeetDraftIdentity;
  /** Active-run abort requests received by the disposable Session. */
  abortCalls: () => number;
  /** Roster the test garden extension mid-Session; its catalog arrives in a frame. */
  advertiseGarden: () => void;
  confirmLatestPrompt: () => void;
  /** Cancel commands the Session has received, in order. */
  cancelCalls: () => readonly CancelCommand[];
  closeCalls: () => number;
  promptCalls: () => number;
  pushFrame: (frame: SessionFrame) => void;
  session: ParakeetSession;
  waitForClose: () => Promise<void>;
  watchCalls: () => number;
}>;

export type TuiFixtureOptions = Readonly<{
  beforePrompt?: (() => Promise<void>) | undefined;
  autoConfirm?: boolean | undefined;
  goal?: Goal | null | undefined;
  loop?: Loop | null | undefined;
  plan?: Plan | null | undefined;
  messages?: readonly SessionMessage[] | undefined;
  /** Start with the test garden extension, which advertises `/water`. */
  garden?: boolean | undefined;
}>;

/** Build one deterministic typed Session without a transport or provider event. */
let nextFixture = 0;
export function createTuiFixture({
  beforePrompt,
  autoConfirm = false,
  goal: initialGoal = null,
  loop: initialLoop = null,
  plan: initialPlan = null,
  messages = [],
  garden = false,
}: TuiFixtureOptions = {}): TuiFixture {
  const fixtureId = `${String(process.pid)}-${String(++nextFixture)}`;
  const identity = {
    agentId: `fixture-agent-${fixtureId}`,
    sessionId: `fixture-session-${fixtureId}`,
  };
  const frames = frameQueue();
  const admittedRequests = new Set<string>();
  const withdrawnRequests = new Set<string>();
  const snapshot: SessionSnapshot = {
    pending: { total: 0, prompts: [], hasMore: false },
    cursor: null,
    hasMore: false,
    messages,
    terminals: [],
    toolOutput: [],
    progress: null,
    sessionId: identity.sessionId,
    activity: idleActivity,
    extensions: {},
    attention: [],
  };
  let currentGoal = initialGoal;
  let currentLoop: Loop | null = initialLoop;
  let gardened = garden;
  const coreSlots = (): SessionExtensionSlots => ({
    [planContract.id]: {
      catalog: {
        protocol: "whistle.catalog/v1",
        commands: [
          {
            id: "plan",
            title: "Plan",
            category: "Conversation",
            projections: { slash: { aliases: ["plan"] } },
          },
        ],
      },
      status: "running",
      revision: "sha256:fixture",
      value:
        initialPlan === null
          ? null
          : encodePlanProjection({
              plan: initialPlan,
              history: {
                ...emptyHistory,
                nextSequence: 2,
                events: [
                  {
                    id: "1",
                    sequence: 1,
                    at: 0,
                    commandId: null,
                    event: initialPlan,
                  },
                ],
              },
            }),
    },
    [goalContract.id]: {
      status: "running",
      revision: "sha256:fixture",
      value:
        currentGoal === null
          ? null
          : encodeGoalProjection({ goal: currentGoal, ended: [], omitted: 0 }),
      catalog: encodeCatalog(goalCatalog),
    },
    [loopContract.id]: {
      status: "running",
      revision: "sha256:fixture",
      value:
        currentLoop === null
          ? null
          : encodeLoopProjection({ loop: currentLoop, history: emptyHistory }),
      catalog: encodeCatalog(loopCatalog),
    },
  });
  const slots = (): SessionExtensionSlots =>
    gardened ? { ...gardenSlots(), ...coreSlots() } : coreSlots();
  let pending: SessionSnapshot["pending"] = {
    total: 0,
    prompts: [],
    hasMore: false,
  };
  let closeCalls = 0;
  let latestPrompt: PromptCommand | undefined;
  let promptCalls = 0;
  const cancelCalls: CancelCommand[] = [];
  let abortCalls = 0;
  let resolveClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  let watchCalls = 0;

  const accepted = (requestId: string): Accepted => ({
    commandId: `owner-${requestId}`,
    status: "accepted",
  });
  // Fallow disposition: these overloads are the maintained public
  // SessionCommandHandler contract. The typed fixture must preserve its
  // command-specific results; a union-returning implementation cannot satisfy
  // that callable interface without an assertion.
  function command(input: PromptCommand | CompactCommand): Promise<Accepted>;
  function command(input: CancelCommand): Promise<CancelResult>;
  function command(
    input: AbortCommand | BranchCommand | OperatorCommand | TitleCommand,
  ): Promise<undefined>;
  function command(input: ForkCommand): Promise<ForkedSession>;
  function command(
    input: SessionCommand,
  ): Promise<Accepted | CancelResult | ForkedSession | undefined>;
  function command(
    input: SessionCommand,
  ): Promise<Accepted | CancelResult | ForkedSession | undefined> {
    if (input.type === "prompt") {
      promptCalls += 1;
      return (beforePrompt?.() ?? Promise.resolve()).then(() => {
        if (withdrawnRequests.has(input.requestId))
          throw new Error("Request was withdrawn");
        admittedRequests.add(input.requestId);
        latestPrompt = input;
        if (
          !pending.prompts.some(
            (prompt) => prompt.commandId === `owner-${input.requestId}`,
          )
        ) {
          pending = {
            total: pending.total + 1,
            prompts: [
              ...pending.prompts,
              {
                requestId: input.requestId,
                commandId: `owner-${input.requestId}`,
                delivery: input.delivery,
                text: input.text,
              },
            ],
            hasMore: false,
          };
          frames.push({
            kind: "update",
            delivery: "live",
            cursor: null,
            messages: [],
            terminals: [],
            activity: queuedActivity(`owner-${input.requestId}`),
            extensions: slots(),
            attention: snapshot.attention,
            pending,
          });
        }
        if (autoConfirm) setTimeout(confirmLatestPrompt, 120);
        return accepted(input.requestId);
      });
    }
    if (input.type === "compact")
      return Promise.resolve(accepted(input.requestId));
    if (input.type === "fork")
      return Promise.resolve({ sessionId: "tui-fixture-fork" });
    if (input.type === "cancel") {
      cancelCalls.push(input);
      // Only a prompt still waiting can be withdrawn; anything else is late.
      if (
        !pending.prompts.some(({ commandId }) => commandId === input.commandId)
      )
        return Promise.resolve({
          status: "too_late",
          commandId: input.commandId,
        });
      pending = {
        total: pending.total - 1,
        prompts: pending.prompts.filter(
          ({ commandId }) => commandId !== input.commandId,
        ),
        hasMore: false,
      };
      observe();
      return Promise.resolve({
        status: "accepted",
        commandId: input.commandId,
      });
    }
    if (input.type === "abort") abortCalls++;
    return Promise.resolve(undefined);
  }
  const commandHandler: SessionCommandHandler = command;

  function confirmLatestPrompt(): void {
    const prompt = latestPrompt;
    if (prompt === undefined) throw new Error("No accepted prompt to confirm");
    pending = {
      total: pending.prompts.filter(
        (queued) => queued.commandId !== `owner-${prompt.requestId}`,
      ).length,
      prompts: pending.prompts.filter(
        (queued) => queued.commandId !== `owner-${prompt.requestId}`,
      ),
      hasMore: false,
    };
    const messageId = `owner-${prompt.requestId}`;
    frames.push({
      pending,
      cursor: `fixture-${prompt.requestId}`,
      delivery: "live",
      kind: "update",
      messages: [
        {
          id: messageId,
          requestId: prompt.requestId,
          commandId: `owner-${prompt.requestId}`,
          sequence: 1,
          value: { content: prompt.text, role: "user", timestamp: 0 },
        },
      ],
      terminals: [],
      activity: runningActivity({
        queue: { state: "running", commandId: `owner-${prompt.requestId}` },
      }),
      extensions: slots(),
      attention: snapshot.attention,
    });
    frames.push({
      kind: "progress",
      activity: runningActivity({
        queue: { state: "running", commandId: `owner-${prompt.requestId}` },
      }),
      progress: {
        messageId: `assistant-${prompt.requestId}`,
        revision: 1,
        text: "Fixture is streaming a reply.",
        textTruncated: false,
        thinking: "",
        thinkingTruncated: false,
      },
    });
  }

  const watch = (): Promise<SessionWatch> => {
    watchCalls += 1;
    let closedWatch = false;
    return Promise.resolve({
      changes: frames.changes,
      close: () => {
        if (closedWatch) return Promise.resolve();
        closedWatch = true;
        closeCalls += 1;
        frames.close();
        resolveClose?.();
        return Promise.resolve();
      },
      snapshot: { ...snapshot, extensions: slots(), pending },
    });
  };

  const observe = () => {
    const waiting = pending.prompts[0];
    frames.push({
      pending,
      kind: "update",
      delivery: "live",
      cursor: "fixture-extension",
      messages: [],
      terminals: [],
      activity:
        waiting === undefined
          ? idleActivity
          : queuedActivity(waiting.commandId),
      extensions: slots(),
      attention: snapshot.attention,
    });
  };
  const admit = (requestId: string, text: string): Accepted => {
    if (withdrawnRequests.has(requestId))
      throw new Error("Request was withdrawn");
    admittedRequests.add(requestId);
    const acceptedCommand = accepted(requestId);
    latestPrompt = { requestId, type: "prompt", delivery: "followUp", text };
    pending = {
      total: pending.total + 1,
      prompts: [
        ...pending.prompts,
        {
          requestId,
          commandId: acceptedCommand.commandId,
          text,
          delivery: "followUp",
        },
      ],
      hasMore: false,
    };
    return acceptedCommand;
  };
  const goalCall = (name: string, input: Json): Promise<Json> => {
    if (name === "goal") {
      const request = decodeGoalCommand(input);
      if (
        !("action" in request) ||
        !["pause", "resume", "clear"].includes(request.action)
      )
        return Promise.reject(
          new Error("Fixture supports pause, resume and clear goal actions"),
        );
      return goalCall(request.action, {}).then(() => ({ type: "done" }));
    }
    if (name === "clear") {
      currentGoal = null;
      return Promise.resolve({});
    }
    if (name === "set") {
      const request = decodeGoalSet(input);
      const acceptedCommand = admit(request.requestId, request.objective);
      currentGoal = {
        revision: acceptedCommand.commandId,
        objective: request.objective,
        state: "active",
        startedAt: fixtureGoalStartedAt,
        pauseCause: null,
      };
      return Promise.resolve({
        goal: encodeGoal(currentGoal),
        accepted: acceptedCommand,
      });
    }
    if (currentGoal === null)
      return Promise.reject(new Error("Session goal does not exist"));
    if (name !== "pause" && name !== "resume")
      return Promise.reject(new Error(`Unknown goal command ${name}`));
    currentGoal = {
      ...currentGoal,
      state: name === "pause" ? "paused" : "active",
      pauseCause: null,
    };
    return Promise.resolve(encodeGoal(currentGoal));
  };
  const loopCall = (name: string, input: Json): Promise<Json> => {
    if (name === "loop") {
      const request = decodeLoopCommand(input);
      if (
        !("action" in request) ||
        !["pause", "resume", "stop"].includes(request.action)
      )
        return Promise.reject(
          new Error("Fixture supports pause, resume and stop loop actions"),
        );
      return loopCall(request.action, {}).then(() => ({
        type: "done",
        notice: {
          type: "success",
          message: `Loop ${currentLoop?.state ?? "cancelled"}.`,
        },
      }));
    }
    if (name === "startSelfPaced" || name === "startFixedInterval") {
      const request = decodeLoopStart(input);
      const acceptedCommand = admit(request.requestId, request.prompt);
      currentLoop = {
        loopId: "fixture-loop",
        origin: "human",
        expiresAt: null,
        prompt: request.prompt,
        mode: name === "startSelfPaced" ? "self_paced" : "fixed_interval",
        cron: null,
        state: "active",
        commandId: acceptedCommand.commandId,
        reason: null,
        nextDueAt: null,
        lastError: null,
        consecutiveFailures: 0,
      };
      return Promise.resolve({
        loop: encodeLoop(currentLoop),
        accepted: acceptedCommand,
      });
    }
    if (currentLoop === null) return Promise.reject(new Error("No loop"));
    const state =
      name === "pause" ? "paused" : name === "resume" ? "active" : "cancelled";
    currentLoop = { ...currentLoop, state };
    return Promise.resolve(encodeLoop(currentLoop));
  };

  return {
    abortCalls: () => abortCalls,
    identity,
    advertiseGarden: () => {
      gardened = true;
      observe();
    },
    closeCalls: () => closeCalls,
    cancelCalls: () => cancelCalls,
    confirmLatestPrompt,
    promptCalls: () => promptCalls,
    pushFrame: frames.push,
    session: {
      latestPending: () => Promise.resolve(pending.prompts.at(-1) ?? null),
      withdraw: (requestId) => {
        if (admittedRequests.has(requestId))
          return Promise.resolve(accepted(requestId));
        withdrawnRequests.add(requestId);
        return Promise.resolve({ status: "unknown" });
      },
      address: `fixture://tui/${fixtureId}`,
      command: commandHandler,
      extension: (extensionId) => ({
        call: (name, input) => {
          const result =
            extensionId === goalContract.id
              ? goalCall(name, input)
              : extensionId === loopContract.id
                ? loopCall(name, input)
                : extensionId === planContract.id && name === "plan"
                  ? Promise.resolve(
                      initialPlan === null
                        ? {
                            type: "done",
                            notice: {
                              type: "info",
                              message: "This Session has no plan.",
                            },
                          }
                        : { type: "done" },
                    )
                  : extensionId === gardenExtensionId && gardened
                    ? gardenCall(name, input)
                    : Promise.reject(new Error("Extension is unavailable"));
          return result.then((value) => {
            observe();
            return value;
          });
        },
      }),
      read: () =>
        Promise.resolve({ ...snapshot, extensions: slots(), pending }),
      watch,
    },
    waitForClose: () => closed,
    watchCalls: () => watchCalls,
  };
}
