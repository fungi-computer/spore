import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "bun:test";
import { act } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";
import { QueryClient } from "@tanstack/query-core";
import { runFungiCli } from "../src/cli.js";
import { fungiModelLoginNotice } from "../src/button/login-notice.js";
import { renderTuiConversation } from "../src/frame-renderer.js";
import { createTuiFixture } from "./fixture.js";
import { noOpClientExtensions } from "./client-extension-fixture.mjs";
import { waitForFrame } from "./native-readiness.js";
import { captureFrame } from "./frame-capture.ts";

const noticeText =
  "Use your own Claude or ChatGPT subscription: /login in a Session";
assert.ok(
  fungiModelLoginNotice.includes(
    "fungi login --provider anthropic --auth-type oauth",
  ),
);
assert.ok(
  fungiModelLoginNotice.includes(
    "fungi login --provider openai --auth-type oauth",
  ),
);

for (const [providerId, status, preferenceProviderId, expected] of [
  ["openai", "signed in", "openai", undefined],
  ["anthropic", "signed in", "anthropic", undefined],
  ["fungi", "missing login", "fungi", noticeText],
  ["fungi", "signed in", "fungi", undefined],
  ["fungi", "catalog unavailable", "fungi", undefined],
  ["fungi", "auth unavailable", "fungi", undefined],
  ["openai", "signed in", null, undefined],
  ["fungi", "missing login", "openai", noticeText],
]) {
  test(`startup notice follows the effective ${providerId} model (${status}, preference ${preferenceProviderId ?? "inherited"})`, async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const directory = await mkdtemp(join(tmpdir(), "fungi-model-notice-"));
    const fixture = createTuiFixture();
    const commands = createWhistle();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const signedIn = status === "signed in" || status === "catalog unavailable";
    const ready = Promise.withResolvers();
    let setup;
    let store;
    let running;
    const effective = {
      agentName: "Shiitake",
      providerId,
      providerName: providerId,
      modelId: "luna",
      modelName: "Luna",
      credential: {
        kind: status === "signed in" ? "oauth" : "missing",
        source:
          status === "catalog unavailable"
            ? "Fungi is unreachable or unavailable. Retry or sign in again."
            : signedIn
              ? `${providerId} login`
              : "Sign in to Fungi",
      },
      label: `Shiitake · Luna · ${providerId}`,
    };
    const host = {
      agentId: "agent-fixture",
      databasePath: join(directory, "agent.sqlite"),
      sessionId: "saved-session",
      session: {
        ...fixture.session,
        address: `fixture://${providerId}`,
        modelPreference: {
          read: async () =>
            preferenceProviderId === null
              ? null
              : { providerId: preferenceProviderId, modelId: "luna" },
          set: async () => undefined,
        },
      },
      effectiveModel: async () => effective,
      sandboxStatus: async () => ({
        mode: "full-access",
        available: true,
      }),
      close: async () => undefined,
    };
    try {
      await act(async () => {
        running = runFungiCli(
          ["resume", "--last", "-C", directory],
          {
            // No Fungi login, even when another provider is configured.
            authModels: { checkAuth: async () => undefined },
          },
          {
            loadThemePreference: async () => ({ theme: "terminal" }),
            prepareClientExtensions: noOpClientExtensions,
            createWhistle: () => commands,
            createQueryClient: () => queryClient,
            createServiceManager: () => ({
              discover: async () => ({
                agents: [
                  {
                    agentId: "one",
                    databasePath: "/project/one/agent.sqlite",
                    sessionCount: 1,
                  },
                ],
                problems: [],
                sessions: [{ ...host, resume: async () => host }],
              }),
              models: async () => [],
              auth: async () => {
                if (status === "auth unavailable")
                  throw new Error("Local account status unavailable");
                return {
                  kind: "status",
                  providers: signedIn
                    ? [
                        {
                          providerId,
                          providerName: providerId,
                          state: "configured",
                          type: "oauth",
                        },
                      ]
                    : [
                        {
                          providerId: "fungi",
                          providerName: "Fungi",
                          state: "unconfigured",
                        },
                      ],
                };
              },
            }),
            createRenderer: async () => {
              setup = await createTestRenderer({
                width: 160,
                height: 28,
                useKittyKeyboard: null,
              });
              return setup.renderer;
            },
            render: (
              root,
              queryClient,
              session,
              runtime,
              onExit,
              theme,
              controls,
            ) => {
              store = controls.interactionStore;
              renderTuiConversation(root, queryClient, {
                ...theme,
                ...controls,
                session,
                commands: runtime,
                onExit,
              });
              ready.resolve();
            },
          },
        );
        await Promise.race([ready.promise, running]);
      });
      await waitForFrame(setup, (frame) => {
        const access = queryClient.getQueryCache().find({
          queryKey: ["tui-model-access", host.session.address],
        });
        return (
          frame.includes("idle") &&
          queryClient.getQueryCache().find({
            queryKey: ["tui-effective-model", host.session.address],
          })?.state.status === "success" &&
          (expected === undefined || frame.includes(noticeText)) &&
          (providerId !== "fungi" ||
            access?.state.status === "success" ||
            access?.state.status === "error")
        );
      });
      await act(async () => setup.renderOnce());
      // Access prerequisites derive from live model access, never a transient
      // interaction notice.
      assert.equal(store.snapshot().notice, undefined);
      assert.ok(!setup.captureCharFrame().includes(effective.label));
      if (expected !== undefined)
        assert.ok(setup.captureCharFrame().includes(noticeText));
    } finally {
      if (setup) {
        await act(async () => setup.renderOnce());
        await captureFrame(
          setup,
          process.env.TUI_MODEL_NOTICE_SHOTS,
          `${providerId}-${status.replaceAll(" ", "-")}-preference-${preferenceProviderId ?? "inherited"}`,
        );
      }
      await act(async () => {
        await commands.execute(
          { namespace: "tui", id: "exit" },
          { origin: "slash" },
        );
        await running;
      });
      await rm(directory, { recursive: true, force: true });
    }
  });
}
