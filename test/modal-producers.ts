import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExtensions } from "@fungi.computer/truffle/extensions";
import {
  createWhistle,
  type WhistlePrompt,
  type WhistleRuntime,
} from "@fungi.computer/whistle";
import {
  createWhistleInteractionHost,
  type WhistleInteractionHost,
} from "@fungi.computer/whistle/interaction";
import { localManagementCommands } from "../src/local-management-commands.js";

/** What a real command did while a scripted person answered. */
export type CommandRun = Readonly<{
  /** Every prompt the command showed, in order. */
  prompts: readonly WhistlePrompt[];
  /** The interaction host; a prompt the script left unanswered is pending on it. */
  host: WhistleInteractionHost;
  /** Resolves when the command ends. */
  finished: Promise<unknown>;
  stop: () => void;
}>;

/** What the real management commands did while a scripted person answered. */
export type ProducerRun = CommandRun &
  Readonly<{
    archived: readonly string[];
    removed: readonly string[];
  }>;

const agents = [
  {
    agentId: "agent_k5f8x2",
    name: "broody-seeker",
    databasePath: "/work/.fungi/agents/agent_k5f8x2/agent.sqlite",
    sessionCount: 12,
  },
  {
    agentId: "agent_m2q9z7",
    name: "fixer",
    databasePath: "/work/.fungi/agents/agent_m2q9z7/agent.sqlite",
    sessionCount: 1,
  },
];

/**
 * Run one real command, contributed by `contribute`, with a person who answers
 * from `script` and then stops, leaving the next prompt pending.
 */
export async function runCommand(
  contribute: (runtime: WhistleRuntime) => void,
  commandId: string,
  script: readonly (string | boolean)[],
  title = "Command",
): Promise<CommandRun> {
  const runtime = createWhistle();
  const host = createWhistleInteractionHost({ title });
  runtime.present(() => host.begin());
  contribute(runtime);
  const prompts: WhistlePrompt[] = [];
  let sequence = -1;
  const unsubscribe = host.subscribe(() => {
    const pending = host.snapshot().prompt;
    if (pending === undefined || pending.sequence === sequence) return;
    sequence = pending.sequence;
    prompts.push(pending.request);
    const answer = script[prompts.length - 1];
    if (answer !== undefined) host.answer(pending.sequence, answer);
  });
  const finished = runtime.execute(commandId, { origin: "slash" });
  let ended = false;
  void finished.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  // Let the script run until the command waits on a prompt it left unanswered.
  const settled = () => ended || prompts.length >= script.length + 1;
  for (let wait = 0; wait < 200 && !settled(); wait += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    prompts,
    host,
    finished,
    stop: () => {
      host.cancel();
      unsubscribe();
      runtime.close();
    },
  };
}

/**
 * Run one real management command (`archive` or `extensions`) with a person
 * who answers from `script` and then stops, leaving the next prompt pending.
 */
export async function runProducer(
  command: "archive" | "extensions",
  script: readonly (string | boolean)[],
): Promise<ProducerRun> {
  const home = await mkdtemp(join(tmpdir(), "fungi-modal-producers-"));
  const archived: string[] = [];
  const removed: string[] = [];
  const owner = localExtensions({ home });
  const run = await runCommand(
    (runtime) =>
      runtime.contribute({
        sourceId: "local-management",
        namespace: "local",
        commands: localManagementCommands(
          "/work",
          {
            discover: () =>
              Promise.resolve({ agents, sessions: [], problems: [] }),
            archive: (request) => {
              archived.push(request.agentId);
              return Promise.resolve();
            },
          },
          () => ({
            ...owner,
            list: () =>
              Promise.resolve([
                {
                  id: "acme-tools",
                  revision: "r1",
                  version: "1.2.0",
                  source: "https://example.test/acme.git",
                  commit: null,
                  capabilities: [],
                  terminals: [],
                },
              ]),
            remove: (id) => {
              removed.push(id);
              return Promise.resolve(true);
            },
          }),
        ),
      }),
    `local:${command}`,
    script,
    "Management",
  );
  return { ...run, archived, removed };
}
