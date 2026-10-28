import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localExtensions,
  type LocalExtensions,
} from "@fungi.computer/truffle/extensions";
import { runFungiCli } from "../src/cli.js";
import { runExtensionCommand } from "../src/extension-command.js";
import { localManagementCommands } from "../src/local-management-commands.js";
import { createWhistle } from "@fungi.computer/whistle";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";

/**
 * Installing an extension that ships skills: the prompt lists them and
 * respects Y/n; --skills and --no-skills answer without a prompt. Local
 * installed extensions only.
 */
let scratch: string;
let home: string;
let project: string;
let store: string;
let source: string;
let owner: LocalExtensions;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "fungi-ext-skills-")));
  home = join(scratch, "home");
  project = join(scratch, "project");
  store = join(project, ".fungi", "agents", "local_store");
  const work = join(scratch, "work");
  const bare = join(scratch, "acme.git");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(store, { recursive: true }),
    mkdir(join(work, "skills", "greeter"), { recursive: true }),
    mkdir(join(work, "skills", "closer"), { recursive: true }),
  ]);
  await writeFile(
    join(work, "package.json"),
    `${JSON.stringify({ name: "fungi-acme", version: "1.0.0", private: true, fungi: { id: "acme-tools", skills: "./skills" } })}\n`,
  );
  for (const name of ["greeter", "closer"])
    await writeFile(
      join(work, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`,
    );
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=f@fungi.test", "-c", "user.name=F", ...args],
      { cwd, encoding: "utf8" },
    );
  git(scratch, "init", "-q", "--bare", "-b", "main", bare);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "acme");
  git(work, "push", "-q", bare, "HEAD:main");
  source = `git+file://${bare}#main`;
  owner = localExtensions({ home });
});

beforeEach(async () => {
  await owner.remove("acme-tools");
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function enabledSkills() {
  return (await owner.agent(store, project)).skills.map(
    (skill) => skill.extensionId,
  );
}

async function add(options: {
  skills?: boolean;
  confirm?: (question: string) => Promise<boolean>;
}) {
  let output = "";
  await runExtensionCommand(
    {
      action: "add",
      arguments: [source],
      cwd: project,
      stdout: {
        write(text) {
          output += text;
        },
      },
      ...options,
    },
    owner,
  );
  return output;
}

test("the install prompt lists the skill names and a yes adds them", async () => {
  const questions: string[] = [];
  const output = await add({
    confirm: (question) => {
      questions.push(question);
      return Promise.resolve(true);
    },
  });
  expect(output).toContain("Skills (2): ");
  expect(output).toContain("greeter");
  expect(output).toContain("closer");
  expect(questions).toEqual(["Add its 2 skills?"]);
  expect(await enabledSkills()).toEqual(["acme-tools"]);
});

test("retrying skills activation does not reinstall or repeat the install questions", async () => {
  const runtime = createWhistle();
  const host = createWhistleInteractionHost({ title: "Manage extensions" });
  runtime.present(() => host.begin());
  const installs: string[] = [];
  const activations: Parameters<LocalExtensions["enableAgentSkills"]>[] = [];
  const retryOwner: LocalExtensions = {
    ...owner,
    add: (...args) => {
      installs.push(args[0]);
      return owner.add(...args);
    },
    enableAgentSkills: (...args) => {
      activations.push(args);
      return activations.length === 1
        ? Promise.reject(new Error("Skills activation failed"))
        : owner.enableAgentSkills(...args);
    },
  };
  runtime.contribute({
    sourceId: "local-management",
    namespace: "local",
    commands: localManagementCommands(
      project,
      {
        discover: () =>
          Promise.reject(new Error("Unexpected archive discovery")),
        archive: () => Promise.reject(new Error("Unexpected archive")),
      },
      () => retryOwner,
    ),
  });
  const failed = Promise.withResolvers<undefined>();
  const answers = ["add", source, true];
  const questions: string[] = [];
  let sequence = -1;
  const unsubscribe = host.subscribe(() => {
    const snapshot = host.snapshot();
    if (snapshot.retryable) failed.resolve(undefined);
    const pending = snapshot.prompt;
    if (pending === undefined || pending.sequence === sequence) return;
    sequence = pending.sequence;
    questions.push(pending.request.message);
    const answer = answers[questions.length - 1];
    if (answer !== undefined) host.answer(pending.sequence, answer);
  });
  const running = runtime.execute(
    { namespace: "local", id: "extensions" },
    { origin: "slash" },
  );
  try {
    await failed.promise;
    expect(installs).toEqual([source]);
    expect(activations).toEqual([[store, "acme-tools"]]);
    expect(await enabledSkills()).toEqual([]);
    host.retry();
    expect((await running).status).toBe("handled");
    expect(installs).toEqual([source]);
    expect(activations).toEqual([
      [store, "acme-tools"],
      [store, "acme-tools"],
    ]);
    expect(questions).toEqual([
      "Manage extensions",
      "Add an extension",
      "Add its 2 skills?",
    ]);
    expect(await enabledSkills()).toEqual(["acme-tools"]);
  } finally {
    host.cancel();
    await running;
    unsubscribe();
    runtime.close();
  }
});

test("the install prompt respects a no", async () => {
  const output = await add({ confirm: () => Promise.resolve(false) });
  expect(output).toContain("fungi extension enable skills acme-tools");
  expect(await enabledSkills()).toEqual([]);
});

test("--skills installs and adds the skills without a prompt", async () => {
  let output = "";
  await runFungiCli(
    ["extension", "add", source, "--skills"],
    {
      cwd: project,
      stdout: {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
    },
    { extensions: owner },
  );
  expect(output).toContain("Added 2 skills");
  expect(await enabledSkills()).toEqual(["acme-tools"]);
});

test("--no-skills installs without adding skills and without a prompt", async () => {
  let output = "";
  await runFungiCli(
    ["extension", "add", source, "--no-skills"],
    {
      cwd: project,
      stdout: {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
    },
    { extensions: owner },
  );
  expect(output).toContain("Skills not added");
  expect(await enabledSkills()).toEqual([]);
});

test("without a terminal or a flag the skills are not added, and the output says how", async () => {
  const output = await add({});
  expect(output).toContain("no terminal to ask");
  expect(await enabledSkills()).toEqual([]);
});

test("enable skills and disable skills toggle them for the folder's Agent", async () => {
  await add({ skills: false });
  const run = async (action: "enable" | "disable") => {
    await runExtensionCommand(
      {
        action,
        arguments: ["skills", "acme-tools"],
        cwd: project,
        stdout: { write: () => undefined },
      },
      owner,
    );
  };
  await run("enable");
  expect(await enabledSkills()).toEqual(["acme-tools"]);
  await run("disable");
  expect(await enabledSkills()).toEqual([]);
});
