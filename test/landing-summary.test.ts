import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openPrivateLocalRuntimeHost } from "@fungi.computer/truffle";
import { readLandingSummary } from "../src/landing-summary.js";

const signal = new AbortController().signal;
const home = process.env.HOME;
const cleanup: string[] = [];

afterEach(async () => {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("the landing's Model line equals the model a fresh chat of that Agent starts with", async () => {
  const root = await mkdtemp(join(tmpdir(), "landing-summary-"));
  cleanup.push(root);
  process.env.HOME = root;
  const models = createModels();
  models.setProvider(openaiProvider());
  spyOn(models, "checkAuth").mockResolvedValue({
    type: "oauth",
    source: "OpenAI login",
  });
  const agent = await openPrivateLocalRuntimeHost(
    { invocationRoot: root, createRequestId: "landing-agent" },
    models,
  );
  try {
    const fresh = async () => {
      const effective = await agent.effectiveModel("a-new-chat", signal);
      return `${effective.providerId}/${effective.modelId}`;
    };
    // No Agent default: the landing and a fresh chat use the available login.
    const fallback = await readLandingSummary(models, [agent], signal);
    expect(fallback.model?.startsWith(await fresh())).toBe(true);

    // /model in a chat sets the Agent default; the landing shows it.
    await agent.session.modelPreference.set({
      providerId: "openai",
      modelId: "gpt-6-astra",
      reasoning: "high",
    });
    const chosen = await readLandingSummary(models, [agent], signal);
    expect(await fresh()).toBe("openai/gpt-6-astra");
    expect(chosen.model).toBe("openai/gpt-6-astra (high)");
    expect(chosen.account).toBe("Signed in with openai");
  } finally {
    await agent.close();
  }
});

test("the picker's chosen Agent drives the landing model; several Agents show none; another Agent is unaffected", async () => {
  const root = await mkdtemp(join(tmpdir(), "landing-picker-"));
  cleanup.push(root);
  process.env.HOME = root;
  const models = createModels();
  models.setProvider(openaiProvider());
  spyOn(models, "checkAuth").mockResolvedValue({
    type: "oauth",
    source: "OpenAI login",
  });
  const a = await openPrivateLocalRuntimeHost(
    { invocationRoot: root, createRequestId: "picker-a" },
    models,
  );
  const b = await openPrivateLocalRuntimeHost(
    { invocationRoot: root, createRequestId: "picker-b" },
    models,
  );
  try {
    await a.session.modelPreference.set({
      providerId: "openai",
      modelId: "gpt-6-astra",
      reasoning: "high",
    });
    const forA = await readLandingSummary(models, [a], signal);
    const forB = await readLandingSummary(models, [b], signal);
    const freshB = await b.effectiveModel("new-chat", signal);
    expect(forA.model).toBe("openai/gpt-6-astra (high)");
    expect(forB.model).not.toBe(forA.model);
    expect(
      forB.model?.startsWith(`${freshB.providerId}/${freshB.modelId}`),
    ).toBe(true);
    // Several Agents and none chosen: no single model is claimed.
    expect((await readLandingSummary(models, [a, b], signal)).model).toBe(
      undefined,
    );
  } finally {
    await a.close();
    await b.close();
  }
});
