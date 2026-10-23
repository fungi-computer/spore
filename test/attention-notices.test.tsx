import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { localAccountOwner } from "@fungi.computer/truffle/login";
import { TuiFrame } from "../src/frame.js";
import {
  modelAccessQuery,
  type TuiModelSource,
} from "../src/button/model-query.js";
import { createTuiFixture } from "./fixture.js";
import { configuredModelAccess } from "./model-access-fixture.js";
import { waitForFrame } from "./native-readiness.js";

test("the sign-in attention item disappears when account access is restored", async () => {
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const query = createQueryClient();
  let signedIn = false;
  const model = {
    providerId: "fungi",
    providerName: "Fungi",
    id: "fixture",
    name: "Fixture",
    reasoning: [],
  };
  const source: TuiModelSource = {
    identity: "attention-proof",
    account: {
      owner: localAccountOwner(
        {
          auth: () =>
            Promise.resolve(configuredModelAccess(signedIn ? [model] : [])),
        },
        () => [],
      ),
      host: "local",
      scope: "user",
      policy: { loginAllowed: () => true },
    },
    models: () => Promise.resolve([model]),
    effectiveModel: () =>
      Promise.resolve({
        agentName: "Shiitake",
        providerId: "fungi",
        providerName: "Fungi",
        modelId: "fixture",
        modelName: "Fixture",
        credential: { kind: "missing", source: "Sign in to Fungi" },
        label: "Shiitake · Fixture · Fungi",
      }),
    modelPreference: {
      read: () => Promise.resolve(null),
      set: () => Promise.resolve(undefined),
    },
  };
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        modelSource={source}
        initialTheme="mocha"
      />
    </QueryClientProvider>,
    { width: 160, height: 30 },
  );
  try {
    await waitForFrame(setup, (frame) =>
      frame.includes("Sign in to Fungi with fungi login"),
    );
    signedIn = true;
    await act(async () => {
      await query.invalidateQueries({
        queryKey: modelAccessQuery(source, "fungi").queryKey,
      });
    });
    // Wait for account observation, then inspect the frame without relying on a timeout to hide the item.
    expect(
      await source.account.owner.access(new AbortController().signal),
    ).not.toEqual([]);
    await waitForFrame(
      setup,
      (frame) => !frame.includes("Sign in to Fungi with fungi login"),
    );
    expect(setup.captureCharFrame()).not.toContain(
      "Sign in to Fungi with fungi login",
    );
  } finally {
    await destroyTestRenderer(setup);
    commands.close();
    query.clear();
    await fixture.waitForClose();
  }
});
