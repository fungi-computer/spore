import { setSystemTime } from "bun:test";
import {
  contributeAccountCommands,
  contributeModelCommands,
  contributeSessionCommands,
  type AccountCommandOptions,
  type AccountOwner,
  type LoginProvider,
  type ModelAccountContext,
} from "@fungi.computer/parakeet/headless";
import type { SessionMessage } from "@fungi.computer/shiitake/client";
import { callTool, memoryHost } from "@fungi.computer/shiitake/testing";
import type { Question } from "@fungi.computer/shiitake-extensions/question";
import { botanicalExtensionsWithSkills } from "@fungi.computer/shiitake-extensions/roster";
import type { SkillCatalog } from "@fungi.computer/shiitake-extensions/skills/source";
import type { WhistlePrompt, WhistleRuntime } from "@fungi.computer/whistle";
import { catalogCommands, parseCatalog } from "@fungi.computer/whistle/catalog";
import { runCommand, type CommandRun } from "./modal-producers.js";
import { createTuiFixture } from "./fixture.js";

const longText =
  "Check the build and fix what broke. If the same test fails twice, stop and tell me which one it was and what you tried, then wait for my answer before touching anything else.";

const shortQuestion = {
  id: "store",
  header: "Store",
  question: "Which store should hold the notes?",
  options: [
    { label: "SQLite", description: "One file." },
    { label: "PostgreSQL", description: "A server." },
  ],
} satisfies Question;

const longQuestion = {
  ...shortQuestion,
  id: "engine",
  question:
    "Which of these storage engines should hold the notes, given that they must survive a restart, be searchable, and stay small enough to sync over a slow connection between two laptops?",
} satisfies Question;

const multipleQuestion = {
  id: "ship",
  header: "Ship",
  question: "Which deliverables should ship?",
  multiple: true,
  options: [
    { label: "Docs", description: "Explain usage." },
    { label: "Examples", description: "Show it working." },
    { label: "Tests", description: "Verify behavior." },
  ],
} satisfies Question;

const skills: SkillCatalog = {
  skills: [
    {
      name: "botanical-retention",
      description: "Retain Botanical code",
      location: "/home/fixture/.agents/skills/retention/SKILL.md",
      origin: { kind: "personal" },
      displayLocation: "~/.agents/skills/retention/SKILL.md",
    },
    {
      name: "herdr",
      description: "Coordinate teams",
      location: "/home/fixture/.agents/skills/herdr/SKILL.md",
      origin: { kind: "personal" },
      displayLocation: "~/.agents/skills/herdr/SKILL.md",
    },
  ],
  diagnostics: [
    {
      path: "/home/fixture/.agents/skills/dup/SKILL.md",
      reason: "collision",
      message: "Earlier skill with this name wins",
      cause: undefined,
    },
    {
      path: "/home/fixture/.agents/skills/broken/SKILL.md",
      reason: "invalid",
      message: "The front matter has no description",
      cause: undefined,
    },
  ],
};

type Host = Awaited<ReturnType<typeof memoryHost>>;
type Session = ReturnType<Host["agent"]["session"]>;

/** Contribute every running extension's advertised catalog, as a client does. */
async function advertised(session: Session) {
  const snapshot = await session.read();
  return (runtime: WhistleRuntime) => {
    for (const [id, slot] of Object.entries(snapshot.extensions)) {
      if (slot.status !== "running" || slot.catalog === undefined) continue;
      runtime.contribute({
        sourceId: id,
        namespace: id,
        commands: catalogCommands(parseCatalog(slot.catalog), (command, args) =>
          session.extension(id).call(command, args),
        ),
      });
    }
  };
}

/** Run one advertised command, keep the prompts it showed, then stop it. */
async function promptsOf(
  session: Session,
  commandId: string,
  script: readonly (string | boolean)[],
) {
  const run = await runCommand(await advertised(session), commandId, script);
  run.stop();
  return run.prompts;
}

type Prompts = readonly WhistlePrompt[];

/** The choice a run showed at `index`. */
function choiceAt(prompts: Prompts, index: number) {
  const prompt = prompts[index];
  if (prompt?.type !== "choice")
    throw new Error(`Prompt ${String(index)} is not a choice`);
  return prompt;
}

/** The confirmation a run showed at `index`. */
function confirmationAt(prompts: Prompts, index: number) {
  const prompt = prompts[index];
  if (prompt?.type !== "confirmation")
    throw new Error(`Prompt ${String(index)} is not a confirmation`);
  return prompt;
}

/** The written answer a run asked for at `index`. */
function textAt(prompts: Prompts, index: number) {
  const prompt = prompts[index];
  if (prompt?.type !== "text")
    throw new Error(`Prompt ${String(index)} asks for no written answer`);
  return prompt;
}

const goalCommand = "botanical-session-goal:goal";
const loopCommand = "botanical-session-loop:loop";

/**
 * Run the real Goal, Loop, Skills and Agent-question commands on a real
 * Shiitake Agent and collect what each shows, keyed by the modal it opens.
 */
export async function collectRestPrompts() {
  const host = await memoryHost({
    extensions: botanicalExtensionsWithSkills({
      catalog: () => Promise.resolve(skills),
      read: () => Promise.reject(new Error("No skill bodies in this test")),
    }),
    script: [
      callTool("question.ask", {
        questions: [shortQuestion, longQuestion, multipleQuestion],
        mode: "continue",
      }),
      "Continuing independent work.",
    ],
  });
  try {
    // The Agent parks its question before any other Session has work to run.
    const questions = host.agent.session("questions");
    await questions.send("Choose storage", { requestId: "choose" });
    await host.settle("questions");
    const answer = await promptsOf(
      questions,
      "botanical-session-question:answerFlow",
      ["option:SQLite", "option:SQLite"],
    );
    const skillsList = await promptsOf(
      questions,
      "botanical-skills:skills",
      [],
    );

    const loop = host.agent.session("loop");
    await loop
      .extension("botanical-session-loop")
      .call("loop", { action: "start", text: longText, requestId: "l1" });
    const loopRun = await promptsOf(loop, loopCommand, ["stop-ask"]);
    const loopStart = await promptsOf(
      host.agent.session("loop-new"),
      loopCommand,
      [],
    );

    // The goal menu says when the goal started; pin the clock it reads.
    setSystemTime(new Date("2026-10-26T09:00:00Z"));
    try {
      const active = host.agent.session("goal-active");
      await active
        .extension("botanical-session-goal")
        .call("goal", { action: "set", objective: longText, requestId: "g1" });
      const clear = await promptsOf(active, goalCommand, ["clear-ask"]);
      const replace = await promptsOf(active, goalCommand, [
        "replace",
        "Plant moss",
      ]);
      const paused = host.agent.session("goal-paused");
      const goal = paused.extension("botanical-session-goal");
      await goal.call("goal", {
        action: "set",
        objective: longText,
        requestId: "g2",
      });
      await goal.call("goal", { action: "pause" });
      const pausedMenu = await promptsOf(paused, goalCommand, []);
      return {
        "goal-menu": choiceAt(clear, 0),
        "goal-paused": choiceAt(pausedMenu, 0),
        "goal-clear-confirm": confirmationAt(clear, 1),
        "goal-replace": textAt(replace, 1),
        "goal-replace-confirm": confirmationAt(replace, 2),
        "loop-menu": choiceAt(loopRun, 0),
        "loop-start": textAt(loopStart, 0),
        "loop-stop-confirm": confirmationAt(loopRun, 1),
        "skills-list": choiceAt(skillsList, 0),
        "question-short": choiceAt(answer, 0),
        "question-long": choiceAt(answer, 1),
        "question-multiple": textAt(answer, 2),
      } satisfies Record<string, WhistlePrompt>;
    } finally {
      setSystemTime();
    }
  } finally {
    await host.close();
  }
}

const providers: readonly LoginProvider[] = [
  {
    id: "alpha",
    name: "Alpha",
    methods: [
      { kind: "api_key", label: "Alpha API key" },
      { kind: "subscription", label: "Alpha Pro" },
    ],
  },
  {
    id: "zeta",
    name: "Zeta",
    methods: [{ kind: "api_key", label: "Zeta API key" }],
  },
];

/** A credential owner whose person is signed in to Alpha only when `signedIn`. */
function accountOwner(signedIn: boolean): AccountOwner {
  return {
    popularProviderIds: [],
    providers: () => Promise.resolve(providers),
    access: () =>
      Promise.resolve(
        signedIn
          ? [{ providerId: "alpha", providerName: "Alpha", type: "api_key" }]
          : [],
      ),
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    status: () => Promise.resolve("Alpha: api_key"),
  };
}

const account = (signedIn: boolean) =>
  ({
    host: "local",
    scope: "user",
    policy: { loginAllowed: () => true },
    owner: accountOwner(signedIn),
  }) satisfies ModelAccountContext;

const accountOptions = {
  sourceId: "modal-account",
  namespace: "account",
  host: "local",
  scope: "user",
  policy: { loginAllowed: () => true },
} satisfies AccountCommandOptions;

const message = {
  id: "entry-1",
  commandId: null,
  sequence: 1,
  value: { role: "user", content: "Fork this message", timestamp: 1 },
} satisfies SessionMessage;

/**
 * Run the real Parakeet model, account and Session commands until each shows
 * its next prompt, so the rules apply to what those commands really send.
 */
export async function commandRuns(): Promise<readonly CommandRun[]> {
  const fixture = createTuiFixture({ messages: [message] });
  return [
    await runCommand(
      (runtime) =>
        contributeModelCommands(
          runtime,
          {
            modelPreference: {
              read: () => Promise.resolve(null),
              set: () => Promise.resolve(),
            },
          },
          {
            account: account(true),
            sourceId: "modal-model",
            namespace: "session",
            models: ["Alpha", "Beta"].map((name) => ({
              providerId: "alpha",
              providerName: "Alpha",
              id: name,
              name,
              reasoning: ["high"],
            })),
            refreshModels: () => Promise.resolve([]),
          },
        ),
      "session:model",
      ["alpha", "1"],
    ),
    await runCommand(
      (runtime) =>
        contributeAccountCommands(runtime, accountOwner(true), accountOptions),
      "account:login",
      ["alpha", "logout"],
    ),
    await runCommand(
      (runtime) =>
        contributeAccountCommands(runtime, accountOwner(false), accountOptions),
      "account:login",
      ["alpha"],
    ),
    await runCommand(
      (runtime) =>
        contributeAccountCommands(runtime, accountOwner(true), accountOptions),
      "account:logout",
      ["alpha"],
    ),
    await runCommand(
      (runtime) =>
        contributeSessionCommands(runtime, fixture.session, {
          sourceId: "modal-session",
          namespace: "session",
          sessionResumeAvailable: false,
          forkAvailable: true,
          onForked: () => undefined,
        }),
      "session:fork",
      [],
    ),
  ];
}
