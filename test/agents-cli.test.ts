import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import {
  AgentArchiveRefused,
  type PrivateLocalServiceManager,
} from "@fungi.computer/truffle/service";
import { runFungiCli } from "../src/cli.js";

type Manager = PrivateLocalServiceManager;

const folder = "/project";

function run(args: readonly string[], archive?: Manager["archive"]) {
  let output = "";
  const archived: unknown[] = [];
  const discovered: unknown[] = [];
  const done = runFungiCli(
    ["agents", ...args, "-C", folder],
    {
      stdout: {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
    },
    {
      createServiceManager: () => ({
        ...unusedManager,
        discover: (root, options) => {
          discovered.push({ root, archived: options?.archived });
          return Promise.resolve({
            agents: [
              {
                agentId: "local_store_fixer",
                name: "fixer",
                createdBy: "Shiitake",
                databasePath:
                  "/project/.fungi/agents/local_store_fixer/agent.sqlite",
                sessionCount: 2,
              },
            ],
            sessions: [],
            problems: [],
          });
        },
        archive:
          archive ??
          ((request) => {
            archived.push(request);
            return Promise.resolve();
          }),
      }),
    },
  );
  return { done, archived, discovered, output: () => output };
}

const unused = (): Promise<never> =>
  Promise.reject(new Error("unused in the agents command"));
const unusedManager: Omit<Manager, "discover" | "archive"> = {
  schedules: () => {
    throw new Error("unused in the agents command");
  },
  reload: unused,
  status: unused,
  start: unused,
  createSession: unused,
  connect: unused,
  inspect: unused,
  auth: unused,
  models: unused,
  stop: unused,
};

test("The user should have a way to: fungi agents archive and unarchive reach any Agent through the service", async () => {
  const archiving = run(["archive", "local_store_fixer"]);
  await archiving.done;
  expect(archiving.archived).toEqual([
    { invocationRoot: folder, agentId: "local_store_fixer", archived: true },
  ]);
  expect(archiving.output()).toContain("Archived local_store_fixer");
  const restoring = run(["unarchive", "local_store_fixer"]);
  await restoring.done;
  expect(restoring.archived).toEqual([
    { invocationRoot: folder, agentId: "local_store_fixer", archived: false },
  ]);
  expect(restoring.output()).toContain("Restored local_store_fixer");
});

test("fungi agents list shows the Agents in use, and --archived the archived ones", async () => {
  const listing = run(["list"]);
  await listing.done;
  expect(listing.discovered).toEqual([{ root: folder, archived: false }]);
  expect(listing.output()).toContain(
    "local_store_fixer  fixer, made by Shiitake  2 conversations",
  );
  const archivedListing = run(["list", "--archived"]);
  await archivedListing.done;
  expect(archivedListing.discovered).toEqual([
    { root: folder, archived: true },
  ]);
});

test("a refused archive surfaces the typed refusal, naming the running command", async () => {
  const refused = run(["archive", "local_store_fixer"], () =>
    Promise.reject(
      new AgentArchiveRefused(
        "running",
        "command command_9 is running in Session main; cancel it first",
      ),
    ),
  );
  await assert.rejects(refused.done, {
    name: "AgentArchiveRefused",
    reason: "running",
    message: /command_9/u,
  });
});

test("fungi agents rejects a missing id, an unknown action and --archived elsewhere", async () => {
  const usage = /Usage: fungi agents/u;
  await assert.rejects(run(["archive"]).done, usage);
  await assert.rejects(run(["tidy", "x"]).done, usage);
  await assert.rejects(run(["archive", "x", "--archived"]).done, usage);
  await assert.rejects(
    runFungiCli(["sessions", "list", "--archived"]),
    /--archived is only valid with fungi agents list/u,
  );
});
