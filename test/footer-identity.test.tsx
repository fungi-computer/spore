import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { notifyManager, QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { localAccountOwner } from "@fungi.computer/truffle/login";
import {
  effectiveModelQuery,
  type TuiModelSource,
} from "../src/button/model-query.js";
import { sigilGutterText } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";

const idleStatus = `${sigilGutterText("●")}idle`;
import { createTuiFixture } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";

let selectedModelId = "next-model";
let selectedReasoning: "high" | undefined;
const source: TuiModelSource = {
  identity: "footer-model-fixture",
  account: {
    owner: localAccountOwner(
      { auth: () => Promise.resolve({ kind: "status", providers: [] }) },
      () => [],
    ),
    host: "local",
    scope: "user",
    policy: { loginAllowed: () => true },
  },
  models: () => Promise.resolve([]),
  modelPreference: {
    read: () =>
      Promise.resolve({ providerId: "openai", modelId: "next-model" }),
    set: () => Promise.resolve(undefined),
  },
  effectiveModel: () =>
    Promise.resolve({
      agentName: "Shiitake",
      providerId: "openai",
      providerName: "OpenAI",
      modelId: selectedModelId,
      modelName: "GPT-6 Astra",
      reasoning: selectedReasoning,
      credential: { kind: "oauth", source: "OpenAI login" },
      label: "Shiitake · GPT-6 Astra (low) · OpenAI login",
    }),
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const sizes: readonly (readonly [number, number])[] = [
  [80, 24],
  [160, 48],
];

// Query completion precedes React Query's scheduled subscriber notifications.
// Wait behind those notifications inside act before asserting rendered output.
async function deliverModelNotifications() {
  await new Promise<undefined>((resolve) => {
    notifyManager.schedule(() => {
      resolve(undefined);
    });
  });
}

for (const [width, height] of sizes) {
  test(`footer names the selected model ids, before and after a new selection, without agent/login/scroll hints (${String(width)})`, async () => {
    selectedModelId = "next-model";
    const fixture = createTuiFixture({
      messages: [
        {
          id: "question",
          commandId: "turn",
          sequence: 1,
          value: { role: "user", content: "Check the footer", timestamp: 1 },
        },
        {
          id: "reply",
          commandId: "turn",
          sequence: 2,
          value: {
            role: "assistant",
            api: "pi",
            model: "gpt-6-astra",
            provider: "openai",
            content: [{ type: "text", text: "The footer is ready." }],
            usage,
            stopReason: "stop",
            timestamp: 2,
          },
        },
      ],
    });
    const query = createQueryClient();
    const commands = createWhistle();
    const setup = await testRender(
      <QueryClientProvider client={query}>
        <TuiFrame
          session={fixture.session}
          commands={commands}
          initialTheme="mocha"
          modelSource={source}
        />
      </QueryClientProvider>,
      { width, height },
    );
    try {
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("The footer is ready.")),
      );
      await act(async () => {
        await query.query({
          ...effectiveModelQuery(source),
          staleTime: "static",
        });
        await deliverModelNotifications();
      });
      await act(async () => setup.mockInput.typeText("Keep this draft"));
      await act(async () => setup.renderOnce());
      await captureFrame(
        setup,
        process.env.TUI_FOOTER_CAPTURE_DIR,
        `footer-${String(width)}`,
      );
      const footer =
        setup
          .captureCharFrame()
          .split("\n")
          .find((line) => line.includes(idleStatus)) ?? "";
      // The selection, not the last reply's model, names the footer model.
      expect(footer).toContain("openai/next-model");
      expect(footer).not.toContain("gpt-6-astra");
      expect(footer).not.toContain("Shiitake");
      expect(footer).not.toContain("login");
      expect(footer).not.toContain("PgUp/PgDn");
      expect(footer).not.toContain("Enter send");
      expect(setup.captureCharFrame()).toContain("Keep this draft");

      // A new selection shows before any reply: saving refreshes this query.
      selectedModelId = "chosen-model";
      await act(async () => {
        await query.invalidateQueries({
          queryKey: effectiveModelQuery(source).queryKey,
        });
        await deliverModelNotifications();
      });
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("openai/chosen-model");
      expect(setup.captureCharFrame()).not.toContain("openai/next-model");
    } finally {
      await destroyTestRenderer(setup);
      commands.close();
      query.clear();
      await fixture.waitForClose();
    }
  });
}

for (const width of [120, 30]) {
  test(`footer appends the thinking level only when the selection has one and it fits (${String(width)})`, async () => {
    selectedModelId = "next-model";
    selectedReasoning = "high";
    const fixture = createTuiFixture({ messages: [] });
    const query = createQueryClient();
    const commands = createWhistle();
    const setup = await testRender(
      <QueryClientProvider client={query}>
        <TuiFrame
          session={fixture.session}
          commands={commands}
          initialTheme="mocha"
          modelSource={source}
        />
      </QueryClientProvider>,
      { width, height: 30 },
    );
    try {
      await act(async () => {
        await query.query({
          ...effectiveModelQuery(source),
          staleTime: "static",
        });
        await deliverModelNotifications();
      });
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain(
        width > 100 ? "openai/next-model (high)" : "openai/next-model",
      );
      if (width <= 100)
        expect(setup.captureCharFrame()).not.toContain("(high)");
      selectedReasoning = undefined;
      await act(async () => {
        await query.invalidateQueries({
          queryKey: effectiveModelQuery(source).queryKey,
        });
        await deliverModelNotifications();
      });
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("openai/next-model");
      expect(setup.captureCharFrame()).not.toContain("(high)");
    } finally {
      await destroyTestRenderer(setup);
      commands.close();
      query.clear();
      await fixture.waitForClose();
    }
  });
}
