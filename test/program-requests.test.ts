import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveProgramRequests } from "../src/button/program-requests.js";
import { requestConversation } from "../src/board/request.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});

async function runtime() {
  const folder = await mkdtemp(join(tmpdir(), "program-requests-"));
  folders.push(folder);
  return folder;
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not met");
    await Bun.sleep(10);
  }
}

test("a program's request opens exactly the conversation it names, once", async () => {
  const opened: { agentId: string; sessionId: string }[] = [];
  const requests = await serveProgramRequests(await runtime(), (target) => {
    opened.push(target);
    return Promise.resolve();
  });
  const outcome = await requestConversation(
    { FUNGI_PANE_REQUESTS: requests.directory },
    { agentId: "agent-scout", sessionId: "session-1" },
  );
  expect(outcome).toBe("asked");
  await until(() => opened.length === 1);
  expect(opened).toEqual([{ agentId: "agent-scout", sessionId: "session-1" }]);
  // The request is consumed before it is acted on, so it cannot run twice.
  expect(await readdir(requests.directory)).toEqual([]);
  await requests.close();
  const gone = await stat(requests.directory).then(
    () => false,
    () => true,
  );
  expect(gone).toBe(true);
});

test("a request that names anything else, or is not one, is dropped", async () => {
  const opened: unknown[] = [];
  const requests = await serveProgramRequests(await runtime(), (target) => {
    opened.push(target);
    return Promise.resolve();
  });
  const send = (name: string, text: string) =>
    writeFile(join(requests.directory, name), text);
  await send("a.json", "{not json");
  await send("b.json", JSON.stringify({ open: "terminal", command: "rm -rf" }));
  await send(
    "c.json",
    JSON.stringify({
      open: "conversation",
      agentId: "agent",
      sessionId: "session",
      extra: true,
    }),
  );
  await send("d.json", "x".repeat(10_000));
  await send(
    "e.json",
    JSON.stringify({ open: "conversation", agentId: "", sessionId: "s" }),
  );
  await send(
    "f.json",
    JSON.stringify({
      open: "conversation",
      agentId: "agent",
      sessionId: "session",
    }),
  );
  await until(() => opened.length === 1);
  expect(opened).toEqual([{ agentId: "agent", sessionId: "session" }]);
  expect(await readdir(requests.directory)).toEqual([]);
  await requests.close();
});

test("a link or a pipe in the folder is dropped without stalling later requests", async () => {
  const opened: unknown[] = [];
  const requests = await serveProgramRequests(await runtime(), (target) => {
    opened.push(target);
    return Promise.resolve();
  });
  execFileSync("mkfifo", [join(requests.directory, "pipe.json")]);
  await symlink("/dev/zero", join(requests.directory, "link.json"));
  await writeFile(
    join(requests.directory, "real.json"),
    JSON.stringify({ open: "conversation", agentId: "a", sessionId: "s" }),
  );
  await until(() => opened.length === 1);
  expect(opened).toEqual([{ agentId: "a", sessionId: "s" }]);
  let left: readonly string[] = ["pending"];
  await until(() => {
    void readdir(requests.directory).then((names) => {
      left = names;
    });
    return left.length === 0;
  });
  await requests.close();
});

test("a program run outside a pane has no shell to ask", async () => {
  expect(
    await requestConversation({}, { agentId: "agent", sessionId: "session" }),
  ).toBe("no-shell");
});
