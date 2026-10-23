import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
// The embedded owner must advertise the same real build as the packed client.
process.env.FUNGI_BUNDLED_BUILD_ID = JSON.parse(
  execFileSync("node", [launcher, "--internal-build-id"], { encoding: "utf8" }),
);
const root = await mkdtemp(join(tmpdir(), "fungi-acp-bundle-"));
const evidenceDirectory =
  process.env.SPORE_PACKED_PROOF_RECEIPT_DIR ??
  (await mkdtemp(join(tmpdir(), "fungi-acp-evidence-")));
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
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
const patchToolCallId = "acp-native-patch";
const patchUpdates = [];
faux.setResponses([
  fauxAssistantMessage("First plain answer."),
  fauxAssistantMessage("Second plain answer."),
  fauxAssistantMessage(
    fauxToolCall("execute", {
      code: 'return await env.computers.local.exec({command:"printf ACP_WORKERD_OK > tool-result.txt"})',
    }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage(
    fauxToolCall(
      "apply_patch",
      {
        patch:
          "*** Begin Patch\n*** Add File: native-acp.txt\n+ACP_NATIVE_OK\n*** End Patch\n",
      },
      { id: patchToolCallId },
    ),
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
let passed = false;
let phase = "initialize";
let stderr = "";
let failure;
async function retainEvidence() {
  let failureDetails;
  if (failure instanceof Error) {
    failureDetails = {
      name: failure.name,
      message: failure.message,
      stack: failure.stack,
    };
    if (failure instanceof acp.RequestError) {
      failureDetails.code = failure.code;
      failureDetails.data = failure.data;
    }
  }
  await writeFile(
    join(evidenceDirectory, "native-apply-patch.json"),
    JSON.stringify(
      {
        toolCallId: patchToolCallId,
        updates: patchUpdates,
        fixtureRoot: root,
        phase,
        passed,
        stderr,
        failure: failureDetails,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
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
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  const exited = once(child, "exit");
  const updates = [];
  let sessionId;
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
  await retainEvidence();
  await acp
    .client({ name: "bundled-stdio-proof" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      if (
        (params.update.sessionUpdate === "tool_call" ||
          params.update.sessionUpdate === "tool_call_update") &&
        params.update.toolCallId === patchToolCallId
      )
        patchUpdates.push(params.update);
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
      phase = "new";
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: project,
        mcpServers: [],
      });
      sessionId = created.sessionId;
      phase = "two plain prompts";
      await retainEvidence();
      for (const expected of ["First plain answer.", "Second plain answer."]) {
        const plain = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "Reply without using tools." }],
        });
        assert.equal(plain.stopReason, "end_turn");
        assert.equal(text(), expected);
        updates.length = 0;
      }
      phase = "prompt";
      await retainEvidence();
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
      console.log(
        "Packed ACP pre-cancel proof passed: initialize, new, workerd tool, native patch tool, exact streaming (faux inference)",
      );
      phase = "cancel";
      await retainEvidence();
      const pending = ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "Write a long answer." }],
      });
      // A rejected prompt cannot emit a chunk; preserve its actual error.
      await Promise.race([cancellationStarted.promise, pending]);
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
      await retainEvidence();
      await ctx.request(acp.methods.agent.session.load, {
        cwd: project,
        sessionId,
        mcpServers: [],
      });
      assert.ok(text().startsWith("First plain answer."));
      assert.equal(text().split("A single streamed answer.").length, 2);
    })
    .catch((cause) => {
      failure = cause;
      throw new Error(`Bundled ACP failed during ${phase}: ${stderr}`, {
        cause,
      });
    });
  phase = "disconnect";
  await retainEvidence();
  child.stdin.end();
  phase = "await-exit";
  await retainEvidence();
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
    "Bundled ACP stdio: initialize, new, two plain prompts, workerd tool, native patch tool, exact streaming, owner cancellation, list, load and disconnect retention passed (faux inference)",
  );
  passed = true;
} finally {
  try {
    await retainEvidence();
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill();
    // This fixture embeds the listener; invoke its owned shutdown handler rather
    // than the external manager that must never terminate its caller's process.
    if (serviceStarted) process.emit("SIGTERM", "SIGTERM");
    try {
      await running;
    } finally {
      try {
        // ACP payloads and failed stores can contain credentials; keep them private.
        if (!passed)
          await cp(root, join(evidenceDirectory, "acp-session-store"), {
            recursive: true,
          });
        console.error(`ACP proof evidence retained at ${evidenceDirectory}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}
