import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { localAccountOwner } from "@fungi.computer/truffle/login";
import {
  effectiveModelQuery,
  type TuiModelSource,
} from "../src/button/model-query.js";
import { TuiFrame } from "../src/frame.js";

import { createTuiFixture } from "./fixture.js";

let credentialKind: "oauth" | "missing" = "missing";
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
      modelId: "next-model",
      modelName: "GPT-6 Astra",
      credential: { kind: credentialKind, source: "OpenAI login" },
      label: "Shiitake · GPT-6 Astra (low) · OpenAI login",
    }),
};

for (const kind of ["missing", "oauth"] as const) {
  test(`empty conversation names model and folder; sign-in hint only when ${kind === "missing" ? "signed out" : "never"}`, async () => {
    credentialKind = kind;
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
          folder="~/garden"
        />
      </QueryClientProvider>,
      { width: 100, height: 30 },
    );
    try {
      await act(async () =>
        setup.waitFor(
          () =>
            query.getQueryData(effectiveModelQuery(source).queryKey) !==
            undefined,
        ),
      );
      await act(async () =>
        setup.waitForFrame((frame) =>
          frame.includes("Model: openai/next-model"),
        ),
      );
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Start a conversation.");
      expect(frame).toContain("Model: openai/next-model");
      expect(frame).toContain("Folder: ~/garden");
      if (kind === "missing")
        expect(frame).toContain("Sign in to start: type /login");
      else expect(frame).not.toContain("Sign in to start");
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      commands.close();
      query.clear();
      await fixture.waitForClose();
    }
  });
}
