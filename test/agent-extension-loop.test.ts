import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { quote } from "shell-quote";
import * as Schema from "effect/Schema";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  mcpFormApprovalContract,
  openPrivateLocalRuntimeHost,
  resolveDefaultCredentialPath,
} from "@fungi.computer/truffle";
import { localExtensions } from "@fungi.computer/truffle/extensions";
import { manageLocalExecRules } from "@fungi.computer/truffle/rules";
import {
  createPrivateLocalServiceManager,
  type PrivateLocalServiceConnection,
} from "@fungi.computer/truffle/service";
import { runPrivateLocalService } from "@fungi.computer/truffle/service-process";
import { waitForAgentSettlement } from "@fungi.computer/shiitake/agent-control";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import type { ShiitakeSession } from "@fungi.computer/shiitake";
import { createIsolatedCliEnvironment } from "./cli-test-isolation.js";

function host(value: string, version: string) {
  return `export default ({ defineExtension, Mycelium, z }) =>
    defineExtension({ id: "authored-tools", version: ${JSON.stringify(version)} }).define({
      tools: () => Mycelium.module({
        id: "authored-tools", name: "authored", description: "Agent-authored tool",
        operations: {
          value: Mycelium.operation({
            description: "Read the installed value", replay: "safe",
            input: z.strictObject({}), output: z.string(),
            execute: () => Promise.resolve(${JSON.stringify(value)})
          })
        }
      })
    });\n`;
}

function exec(input: {
  command?: string;
  executable?: string;
  args?: string[];
  escape?: { justification: string };
}) {
  return `return await env.computers.local.exec(${JSON.stringify(input)});`;
}

async function waitForApprovalDelivery(
  session: ShiitakeSession,
  afterMessage: number,
): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await session.read();
    const notices = snapshot.messages
      .slice(afterMessage)
      .flatMap(({ value }) => (value.role === "user" ? [value] : []));
    if (notices.length > 0 && snapshot.activity.queue.state === "idle") {
      expect(notices).toHaveLength(1);
      return notices
        .map((notice) =>
          Schema.is(Schema.String)(notice.content)
            ? notice.content
            : notice.content
                .map((part) => (part.type === "text" ? part.text : ""))
                .join(""),
        )
        .join("\n");
    }
    await Bun.sleep(20);
  }
  throw new Error("The approval result follow-up did not settle");
}

for (const mode of ["full-access", "workspace", "read-only"] as const) {
  test.skipIf(mode !== "full-access" && process.platform !== "linux")(
    `a ${mode} Agent authors, installs, enables and reloads its own tool under the current approval policy`,
    async () => {
      const isolated = await createIsolatedCliEnvironment();
      const area = await mkdtemp(join(tmpdir(), "fungi-extension-loop-"));
      const project = join(area, "project");
      const bin = join(area, "bin");
      const directory = join(isolated.home, ".fungi", "service");
      await Promise.all([
        mkdir(project),
        mkdir(bin),
        mkdir(directory, { recursive: true, mode: 0o700 }),
      ]);
      const cli = resolve(import.meta.dir, "../src/cli.tsx");
      await writeFile(
        join(bin, "fungi"),
        `#!/bin/sh\nexec ${quote([process.execPath, cli])} "$@"\n`,
        { mode: 0o755 },
      );
      const first = host("first-installed-value", "1.0.0");
      const second = host("second-installed-value", "2.0.0");
      const manifest = (version: string) =>
        JSON.stringify({
          name: "fungi-authored-tools",
          version,
          private: true,
          type: "module",
          exports: { "./host": "./host.mjs" },
          fungi: { id: "authored-tools", capabilities: ["run_tools"] },
        });
      const writeSource = [
        'const fs = require("node:fs");',
        'fs.mkdirSync("ext", { recursive: true });',
        `fs.writeFileSync("ext/package.json", ${JSON.stringify(manifest("1.0.0"))});`,
        `fs.writeFileSync("ext/host.mjs", ${JSON.stringify(first)});`,
      ].join("\n");
      const editSource = [
        'const fs = require("node:fs");',
        `fs.writeFileSync("ext/package.json", ${JSON.stringify(manifest("2.0.0"))});`,
        `fs.writeFileSync("ext/host.mjs", ${JSON.stringify(second)});`,
      ].join("\n");
      const add = `fungi -C ${quote([project])} extension add ./ext --no-skills`;
      const enable = "fungi extension enable agent authored-tools";
      const reload = "fungi reload";
      const sandboxed = mode !== "full-access";
      const processStep = (
        input: Parameters<typeof exec>[0],
        requested?: "exec" | "extension-install",
        decision: "approve" | "deny" = "approve",
      ) => {
        const approval = sandboxed ? requested : undefined;
        return {
          code: exec(
            approval === undefined
              ? input
              : {
                  ...input,
                  escape: {
                    justification:
                      "Author or install this Agent's extension through the ordinary Fungi CLI.",
                  },
                },
          ),
          approval,
          decision,
        };
      };
      const call = {
        code: "return await env.authored.value({});",
        approval: undefined,
        decision: "approve" as const,
      };
      const steps = [
        processStep(
          { executable: process.execPath, args: ["-e", writeSource] },
          mode === "read-only" ? "exec" : undefined,
        ),
        processStep(
          { command: `${add} && ${enable} && ${reload}` },
          "extension-install",
        ),
        call,
        processStep(
          { executable: process.execPath, args: ["-e", editSource] },
          mode === "read-only" ? "exec" : undefined,
        ),
        call,
        ...(sandboxed
          ? [processStep({ command: add }, "extension-install", "deny")]
          : []),
        processStep({ command: `${add} && ${reload}` }, "extension-install"),
        call,
        processStep({ command: `${enable} && ${reload}` }, "exec"),
        call,
        call,
      ];
      const faux = fauxProvider({
        provider: "extension-loop-fixture",
        models: [{ id: "extension-loop-model" }],
      });
      faux.setResponses(
        steps.flatMap((step) => [
          fauxAssistantMessage(fauxToolCall("execute", { code: step.code }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Turn completed"),
          ...(step.approval === undefined
            ? []
            : [fauxAssistantMessage("Approval result received")]),
        ]),
      );
      const models = createModels();
      models.setProvider(faux.provider);
      const configRoot = {
        home: isolated.home,
        credentialPath: resolveDefaultCredentialPath(isolated.home),
        serviceDirectory: directory,
      };
      const startService = () =>
        runPrivateLocalService(
          directory,
          (options) =>
            openPrivateLocalRuntimeHost(
              {
                ...options,
                configRoot,
                providerId: "extension-loop-fixture",
                modelId: "extension-loop-model",
              },
              models,
            ),
          undefined,
          undefined,
          undefined,
          undefined,
          configRoot,
        );
      let running = startService();
      const createManager = () =>
        createPrivateLocalServiceManager({
          directory,
          home: isolated.home,
          executionPath: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        });
      let manager = createManager();
      let connection: PrivateLocalServiceConnection | undefined;
      let watch: Awaited<ReturnType<ShiitakeSession["watch"]>> | undefined;
      let draining: Promise<void> | undefined;
      const installed = localExtensions({ home: isolated.home });
      const ready = async () => {
        await Promise.race([
          running,
          (async () => {
            for (let attempt = 0; attempt < 300; attempt += 1) {
              if ((await manager.status()) !== undefined) {
                return;
              }
              await Bun.sleep(20);
            }
            throw new Error("Extension-loop Local service did not start");
          })(),
        ]);
      };
      try {
        await ready();
        const identity = await manager.status();
        if (identity === undefined)
          throw new Error("Local identity is missing");
        connection = await manager.connect({
          invocationRoot: project,
          mode,
        });
        expect(await connection.sandboxStatus()).toMatchObject({
          mode,
          available: true,
        });
        let session = connection.session;
        if (sandboxed) {
          watch = await session.watch();
          const observation = watch;
          draining = (async () => {
            for await (const frame of observation.changes) {
              void frame;
              // A real UI consumes its observation; assertions below use fresh
              // canonical snapshots rather than keeping a second frame cache.
            }
          })();
        }
        let sequence = 0;
        const approvals = new Set<string>();
        const performTurn = async () => {
          const before = (await session.read()).messages.filter(
            ({ value }) => value.role === "toolResult",
          ).length;
          sequence += 1;
          const step = steps[sequence - 1];
          if (step === undefined) throw new Error("No scripted extension step");
          const accepted = await session.command({
            type: "prompt",
            text: `Extension loop step ${String(sequence)}`,
            requestId: `extension-loop-${String(sequence)}`,
            delivery: "followUp",
          });
          const { terminal } = await waitForAgentSettlement(
            session,
            accepted.commandId,
            15_000,
            new AbortController().signal,
          );
          expect(terminal.outcome).toBe("completed");
          const results = (await session.read()).messages
            .flatMap(({ value }) =>
              value.role === "toolResult" ? [value] : [],
            )
            .slice(before);
          expect(results).toHaveLength(1);
          for (const result of results) expect(result.isError).toBe(false);
          const forms = bindSessionExtension(session, mcpFormApprovalContract);
          const view = forms.view(await session.read());
          if (step.approval !== undefined) {
            const pending =
              view.status === "running" ? view.value?.pending[0] : undefined;
            if (pending === undefined)
              throw new Error("The escaped step has no real approval");
            expect(pending.review?.kind).toBe(step.approval);
            expect(pending.approval.canAnswer).toBe(true);
            expect(pending.review?.prefix).toBeUndefined();
            if (step.approval === "extension-install")
              expect(pending.review?.alwaysAllowUnavailableReason).toContain(
                "fresh approval",
              );
            expect(approvals.has(pending.approval.record.recordId)).toBe(false);
            approvals.add(pending.approval.record.recordId);
            const beforeNotice = (await session.read()).messages.length;
            const answered = await forms.call("answer", {
              id: pending.id,
              expectedRevision: pending.approval.record.revision,
              decision: step.decision,
            });
            expect(answered).toMatchObject({
              kind: "answered",
              view: {
                record: {
                  state: step.decision === "approve" ? "applied" : "denied",
                },
              },
            });
            // Apply delivers its real native result as a new follow-up. Wait for that
            // command, not just the original pending_approval tool result, to settle.
            const notice = await waitForApprovalDelivery(session, beforeNotice);
            expect(manageLocalExecRules(project, "list")).toEqual([]);
            return notice;
          }
          expect(
            view.status === "running" ? view.value?.pending : undefined,
          ).toEqual([]);
          return results
            .flatMap((result) =>
              result.content.map((part) =>
                part.type === "text" ? part.text : "",
              ),
            )
            .join("\n");
        };
        const turn = async () => {
          const step = sequence + 1;
          try {
            return await performTurn();
          } catch (cause) {
            throw new Error(
              `The ${mode} extension loop failed at step ${String(step)}`,
              { cause },
            );
          }
        };
        await turn();
        expect(await readFile(join(project, "ext", "host.mjs"), "utf8")).toBe(
          first,
        );
        expect(await turn()).toContain("Configuration reloaded");
        expect(await turn()).toContain("first-installed-value");
        await turn();
        expect(await readFile(join(project, "ext", "host.mjs"), "utf8")).toBe(
          second,
        );
        expect(await turn()).toContain("first-installed-value");
        if (sandboxed) {
          const beforeReinstall = await installed.list();
          expect(await turn()).toContain('"reason":"declined"');
          expect(await installed.list()).toEqual(beforeReinstall);
        }
        expect(await turn()).toContain("Configuration reloaded");
        expect(await turn()).toContain("first-installed-value");
        // Core fingerprints manifest/schema/config, not source. A behavior update
        // bumps the host version; live replacement must refuse, not hot-swap it.
        expect(await turn()).toContain("this change needs a restart");
        expect(await turn()).toContain("first-installed-value");
        expect(await manager.status()).toMatchObject({
          serviceId: identity.serviceId,
          pid: identity.pid,
        });
        const selection = {
          invocationRoot: project,
          databasePath: connection.databasePath,
          sessionId: connection.sessionId,
        };
        await watch?.close();
        await draining;
        draining = undefined;
        watch = undefined;
        await connection.close();
        connection = undefined;
        process.emit("SIGTERM", "SIGTERM");
        await running;
        running = startService();
        manager = createManager();
        await ready();
        connection = await manager.connect(selection);
        session = connection.session;
        expect((await manager.status())?.serviceId).not.toBe(
          identity.serviceId,
        );
        expect(await turn()).toContain("second-installed-value");
        expect(faux.getPendingResponseCount()).toBe(0);
      } finally {
        await watch?.close();
        await draining;
        await connection?.close();
        // This test embeds the listener; invoke its owned shutdown handler, not the
        // SDK stop method that must never terminate its caller's process.
        process.emit("SIGTERM", "SIGTERM");
        try {
          await running;
        } finally {
          await Promise.all([
            rm(area, { recursive: true, force: true }),
            isolated.cleanup(),
          ]);
        }
      }
    },
    60_000,
  );
}
