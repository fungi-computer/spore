import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openPrivateLocalRuntimeHost } from "@fungi.computer/truffle";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle/service";
import { runPrivateLocalService } from "@fungi.computer/truffle/service-process";

// The actual CLI bundle talks to a real persistent Local owner. Only inference
// is deterministic here; the separate Zed witness uses the real Luna model.
const bundle = resolve(
  process.argv[2] ?? "../../.botanical/fungi-cli-package/dist/cli.js",
);
await access(bundle);
const launcher = join(dirname(bundle), "fungi.cjs");
await access(launcher);
const root = await mkdtemp(join(tmpdir(), "fungi-acp-bundle-"));
const home = join(root, "home");
const project = join(root, "project");
const directory = join(home, ".fungi/service");
await mkdir(directory, { recursive: true });
await mkdir(project);
await chmod(directory, 0o700);
const faux = fauxProvider({
  tokensPerSecond: 100,
  tokenSize: { min: 1, max: 1 },
});
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("execute", {
      code: 'async () => await Local_Computer.exec({command:"printf ACP_WORKERD_OK > tool-result.txt"})',
    }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage(
    fauxToolCall("apply_patch", {
      patch:
        "*** Begin Patch\n*** Add File: native-acp.txt\n+ACP_NATIVE_OK\n*** End Patch\n",
    }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("A single streamed answer."),
  fauxAssistantMessage("Keep writing until cancelled. ".repeat(200)),
]);
const models = createModels();
models.setProvider(faux.provider);
const running = runPrivateLocalService(directory, (options) =>
  openPrivateLocalRuntimeHost(
    {
      ...options,
      providerId: faux.provider.id,
      modelId: faux.getModel().id,
    },
    models,
  ),
);
const manager = createPrivateLocalServiceManager({ directory });
let child;
let serviceStarted = false;
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await manager.status()) {
      serviceStarted = true;
      break;
    }
    await delay(100);
  }
  assert.equal(
    serviceStarted,
    true,
    "Fixture service must be ready before launching the CLI",
  );
  child = spawn("node", [launcher, "acp", "-C", project], {
    cwd: project,
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  const exited = once(child, "exit");
  const updates = [];
  let sessionId;
  let phase = "prompt";
  const cancellationStarted = Promise.withResolvers();
  const text = () =>
    updates
      .flatMap((update) =>
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
          ? [update.content.text]
          : [],
      )
      .join("");
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  await acp
    .client({ name: "bundled-stdio-proof" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      if (
        phase === "cancel" &&
        params.update.sessionUpdate === "agent_message_chunk"
      )
        cancellationStarted.resolve();
    })
    .connectWith(stream, async (ctx) => {
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      });
      assert.equal(initialized.protocolVersion, acp.PROTOCOL_VERSION);
      assert.deepEqual(initialized.authMethods[0].args, ["login"]);
      assert.deepEqual(
        initialized.agentCapabilities.sessionCapabilities.list,
        {},
      );
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: project,
        mcpServers: [],
      });
      sessionId = created.sessionId;
      const answer = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "Reply once." }],
      });
      assert.equal(answer.stopReason, "end_turn");
      assert.equal(text(), "A single streamed answer.");
      assert.equal(
        await readFile(join(project, "tool-result.txt"), "utf8"),
        "ACP_WORKERD_OK",
        "The execute tool must cross the real workerd and Computer boundary",
      );
      assert.equal(
        await readFile(join(project, "native-acp.txt"), "utf8"),
        "ACP_NATIVE_OK\n",
      );
      phase = "cancel";
      const pending = ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "Write a long answer." }],
      });
      await cancellationStarted.promise;
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      assert.equal((await pending).stopReason, "cancelled");
      const owned = await manager.inspect({
        invocationRoot: project,
        sessionId,
      });
      try {
        assert.equal(owned.snapshot.activity.queue.state, "idle");
        assert.ok(
          owned.snapshot.terminals.some(
            (terminal) => terminal.outcome === "cancelled",
          ),
        );
      } finally {
        await owned.close();
      }
      const listed = await ctx.request(acp.methods.agent.session.list, {
        cwd: project,
      });
      assert.ok(
        listed.sessions.some((session) => session.sessionId === sessionId),
      );
      updates.length = 0;
      phase = "load";
      await ctx.request(acp.methods.agent.session.load, {
        cwd: project,
        sessionId,
        mcpServers: [],
      });
      assert.ok(text().startsWith("A single streamed answer."));
      assert.equal(text().split("A single streamed answer.").length, 2);
    })
    .catch((cause) => {
      throw new Error(`Bundled ACP failed during ${phase}: ${stderr}`, {
        cause,
      });
    });
  child.stdin.end();
  assert.deepEqual(await exited, [0, null], stderr);
  const retained = await manager.inspect({
    invocationRoot: project,
    sessionId,
  });
  try {
    assert.ok(retained.snapshot.messages.length > 0);
  } finally {
    await retained.close();
  }
  console.log(
    "Bundled ACP stdio: initialize, new, workerd tool, native patch tool, exact streaming, owner cancellation, list, load and disconnect retention passed (faux inference)",
  );
} finally {
  if (child !== undefined && child.exitCode === null) child.kill();
  if (serviceStarted) await manager.stop();
  await running;
  await rm(root, { recursive: true, force: true });
}
