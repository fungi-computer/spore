import corral from "@fungi.computer/corral";
import assert from "node:assert/strict";
import process from "node:process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { EventEmitter, once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { QueryClient } from "@tanstack/query-core";
import { createWhistle } from "@fungi.computer/whistle";
import {
  createParakeetInteractions,
  seedSessionQuery,
} from "@fungi.computer/parakeet/headless";
import { prepareClientExtensions } from "@fungi.computer/spore/client-extensions";

const root = await mkdtemp(join(tmpdir(), "fungi-client-extension-host-"));
const socketPath = join(root, "herdr.sock");
const previousEnvironment = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
};
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      method: Schema.String,
      params: Schema.Struct({
        pane_id: Schema.String,
        agent: Schema.String,
        seq: Schema.Number,
        state: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
      }),
    }),
  ),
);
const requests = [];
const events = new EventEmitter();
const sockets = new Set();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  const lines = createInterface({ input: socket });
  const interrupted = (cause) => assert.equal(cause.code, "ECONNRESET");
  socket.on("error", interrupted);
  lines.on("error", interrupted);
  lines.once("line", (line) => {
    const request = decodeRequest(line);
    requests.push(request);
    socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    events.emit("request");
  });
});
server.listen(socketPath);
await once(server, "listening");

async function reported(state, after = 0, method = "pane.report_agent") {
  const signal = globalThis.AbortSignal.timeout(2000);
  for (;;) {
    const found = requests
      .slice(after)
      .find(
        (request) =>
          request.method === method && request.params.state === state,
      );
    if (found !== undefined) return found;
    await once(events, "request", { signal });
  }
}
const session = (address) => ({
  address,
  watch: async () => {
    throw new Error("borrow the existing query observation");
  },
});
const snapshot = (state) => ({
  pending: { total: 0, prompts: [], hasMore: false },
  cursor: null,
  hasMore: false,
  messages: [],
  progress: null,
  sessionId: "proof",
  terminals: [],
  extensions: {},
  attention: [],
  activity: {
    queue:
      state === "idle"
        ? { state: "idle" }
        : { state: "running", commandId: "proof-command" },
    cancellationRequested: false,
    retry: null,
    activeTool: null,
    lastModelChoiceSequence: null,
    compaction: null,
  },
});
const errors = [];
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const commands = createWhistle();
const interactions = createParakeetInteractions();
const unpresent = interactions.attach(commands.present);
const answer = Promise.withResolvers();
commands.contribute({
  sourceId: "host-proof",
  namespace: "host-proof",
  commands: [
    {
      id: "question",
      title: "Question",
      category: "proof",
      handler: async ({ interaction }) => {
        assert.ok(interaction);
        assert.equal(
          await interaction.prompt({
            type: "confirmation",
            message: "PRIVATE_QUESTION_MUST_NOT_BE_REPORTED",
          }),
          true,
        );
        await answer.promise;
      },
    },
  ],
});
let scope;
try {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = socketPath;
  process.env.HERDR_PANE_ID = "proof-pane";
  scope = await Effect.runPromise(Scope.make());
  // The composition root selects Corral through the same public client entry admission.
  const extensions = await Effect.runPromise(
    prepareClientExtensions({
      invocationRoot: process.cwd(),
      entries: [],
      clients: [corral],
      queryClient,
      onError: (error) => errors.push(error),
    }).pipe(Scope.provide(scope)),
  );
  const first = session("fixture://first");
  seedSessionQuery(queryClient, first, snapshot("idle"));
  const firstScope = await Effect.runPromise(Scope.fork(scope, "sequential"));
  await Effect.runPromise(
    extensions.attach(first, interactions).pipe(Scope.provide(firstScope)),
  );
  await reported("idle");
  seedSessionQuery(queryClient, first, snapshot("working"));
  await reported("working");
  const question = commands.execute("host-proof:question", { origin: "slash" });
  const block = await reported("blocked");
  assert.equal(block.params.message, "Waiting for your response");
  assert.ok(!JSON.stringify(requests).includes("PRIVATE_QUESTION"));
  const pending = interactions.snapshot().open.host.snapshot().prompt;
  const afterBlock = requests.length;
  interactions.snapshot().open.host.answer(pending.sequence, true);
  await reported("working", afterBlock);
  answer.resolve();
  assert.equal((await question).status, "handled");
  seedSessionQuery(queryClient, first, snapshot("idle"));
  await reported("idle", afterBlock);
  await Effect.runPromise(Scope.close(firstScope, Exit.void));
  await reported(undefined, 0, "pane.release_agent");
  const beforeSecond = requests.length;
  const second = session("fixture://second");
  seedSessionQuery(queryClient, second, snapshot("working"));
  const secondScope = await Effect.runPromise(Scope.fork(scope, "sequential"));
  await Effect.runPromise(
    extensions.attach(second, interactions).pipe(Scope.provide(secondScope)),
  );
  await reported("working", beforeSecond);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  scope = undefined;
  assert.equal(
    requests.filter((request) => request.method === "pane.release_agent")
      .length,
    2,
  );
  assert.deepEqual(errors, []);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.params.agent, "shiitake");
    assert.equal(request.params.pane_id, "proof-pane");
    if (index > 0)
      assert.ok(request.params.seq > requests[index - 1].params.seq);
  }
  process.stdout.write(
    "default extension: idle → working → blocked → working → idle; selected scope releases and reattaches; question content stays private\n",
  );
} finally {
  answer.resolve();
  interactions.close();
  if (scope !== undefined)
    await Effect.runPromise(Scope.close(scope, Exit.void));
  unpresent();
  commands.close();
  queryClient.clear();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve, reject) =>
    server.close((cause) => (cause ? reject(cause) : resolve())),
  );
  await rm(root, { recursive: true, force: true });
}
