import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { captureFrame } from "./frame-capture.ts";
import * as Effect from "effect/Effect";
import { act } from "react";
import { QueryClient } from "@tanstack/query-core";
import { createTestRenderer } from "@opentui/core/testing";
import { createWhistle } from "@fungi.computer/whistle";
import { prepareClientExtensions } from "../src/client-extensions.js";
import { runTuiCli } from "../src/cli-runtime.js";
import {
  createDesignTuiFixture,
  runningToolsDesignSnapshot,
} from "./design-fixture.js";
import { waitForFrame } from "./native-readiness.js";

async function runSession() {
  const home = process.env.HOME;
  const realAttach = process.env.TUI_DIAGNOSTICS_SCENARIO === "attachment";
  assert.ok(home, "the parent supplies an isolated fixture home");
  assert.equal(process.stdout.isTTY, true, "the fixture runs on its own PTY");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Incomplete streamed tool code reliably exercises source preservation.
  // Valid deeply nested code may format successfully; stack depth is not a law.
  const content = "return await files.read({";
  const message = runningToolsDesignSnapshot.messages.at(-1);
  const fixture = createDesignTuiFixture({
    snapshot: {
      ...runningToolsDesignSnapshot,
      messages: [
        {
          ...message,
          value: {
            ...message.value,
            content: [
              {
                type: "toolCall",
                id: "incomplete-code",
                name: "execute",
                arguments: { code: content },
              },
            ],
          },
        },
      ],
    },
  });
  const commands = createWhistle();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let setup;
  let running;
  const ready = Promise.withResolvers();
  let reportExtensionFailure;
  try {
    await act(async () => {
      running = runTuiCli(
        {
          invocationRoot: home,
          sessionId: fixture.session.address,
          initialCommandError: realAttach
            ? undefined
            : "Initial command failed",
          extensions: realAttach
            ? [
                fileURLToPath(
                  new URL(
                    "./fixtures/diagnostic-attach-extension.fixture.mjs",
                    import.meta.url,
                  ),
                ),
              ]
            : [],
        },
        {
          loadThemePreference: async () => ({ theme: "terminal" }),
          prepareClientExtensions: (options) => {
            if (realAttach) return prepareClientExtensions(options);
            reportExtensionFailure = options.onError;
            options.onError(new Error("Extension preparation failed"));
            options.onError(new Error("Second extension preparation failed"));
            return Effect.succeed({
              entries: Effect.succeed([]),
              attach: () => Effect.void,
            });
          },
          createQueryClient: () => queryClient,
          createWhistle: () => commands,
          createServiceManager: () => ({
            connect: async () => ({
              sandboxStatus: async () => ({
                mode: "full-access",
                available: true,
              }),
              agentId: "agent-fixture",
              sessionId: "session-fixture",
              session: {
                ...fixture.session,
                modelPreference: {
                  read: async () => null,
                  set: async () => undefined,
                },
              },
              databasePath: join(home, "agent.sqlite"),
              close: async () => undefined,
            }),
            models: async () => [],
          }),
          createRenderer: async () => {
            setup = await createTestRenderer({
              width: 96,
              height: 24,
              useKittyKeyboard: null,
            });
            ready.resolve();
            return setup.renderer;
          },
        },
      );
      await Promise.race([ready.promise, running]);
    });
    await waitForFrame(setup, (frame) => frame.includes("Ran script"));
    if (realAttach) {
      await waitForFrame(setup, (frame) => frame.includes("Client extension:"));
      await captureFrame(
        setup,
        process.env.TUI_DIAGNOSTICS_SHOTS,
        "real-attachment",
      );
      await waitForFrame(setup, (frame) =>
        frame.includes("Extension attachment failed"),
      );
      await captureFrame(
        setup,
        process.env.TUI_DIAGNOSTICS_SHOTS,
        "real-attachment",
      );
    } else {
      await captureFrame(
        setup,
        process.env.TUI_DIAGNOSTICS_SHOTS,
        "preparation",
      );
      await waitForFrame(
        setup,
        (frame) =>
          frame.includes("Initial command failed") &&
          frame.includes("Extension preparation failed") &&
          frame.includes("Second extension preparation failed"),
      );
      await act(async () =>
        reportExtensionFailure(new Error("Extension live callback failed")),
      );
      await waitForFrame(setup, (frame) =>
        frame.includes("Extension live callback failed"),
      );
      await captureFrame(
        setup,
        process.env.TUI_DIAGNOSTICS_SHOTS,
        "live-callback",
      );
    }
    await act(async () => setup.mockInput.pressKey("o", { ctrl: true }));
    await waitForFrame(setup, () =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["tui-tool-code", content] })
        .some((query) => query.state.status === "success"),
    );
    const formatted = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["tui-tool-code", content] })[0];
    assert.deepEqual(
      formatted.state.data,
      { status: "original", content, reason: "format-unavailable" },
      "failed display formatting preserves the original code",
    );
    await act(async () => {
      await commands.execute("tui:exit", { origin: "slash" });
      await running;
      reportExtensionFailure?.(new Error("Extension cleanup failed"));
    });
  } finally {
    await act(async () => {
      await commands.execute("tui:exit", { origin: "slash" });
      await running;
    });
  }
}

await runSession();
