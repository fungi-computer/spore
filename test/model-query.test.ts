import { expect, test } from "bun:test";
import { QueryObserver, CancelledError } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { localAccountOwner } from "@fungi.computer/truffle/login";
import type { ModelPreference } from "@fungi.computer/shiitake/model-preference";
import {
  effectiveModelQuery,
  modelAccessQuery,
  modelCatalogQuery,
  modelPreferenceQuery,
  type TuiModelSource,
} from "../src/button/model-query.js";

function modelSource(identity: string): TuiModelSource {
  return {
    identity,
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
}

test("Session preference owners remain isolated even when the catalog is shared", async () => {
  const client = createQueryClient();
  let saved: ModelPreference | null = null;
  const first = modelSource("shared-catalog");
  const second: TuiModelSource = {
    ...first,
    modelPreference: {
      read: () => Promise.resolve(saved),
      set: (next) => {
        saved = next;
        return Promise.resolve(undefined);
      },
    },
  };
  const choice: ModelPreference = { providerId: "fungi", modelId: "fixture" };
  try {
    expect(await client.query(modelPreferenceQuery(first))).toBeNull();
    expect(await client.query(modelPreferenceQuery(second))).toBeNull();
    await second.modelPreference.set(choice);
    expect(await client.query(modelPreferenceQuery(second))).toEqual(choice);
    expect(await client.query(modelPreferenceQuery(first))).toBeNull();
    expect(client.getQueryCache().getAll()).toHaveLength(2);
  } finally {
    client.clear();
  }
});

test("Local model reads refresh through Agar's client instead of inheriting its freshness window", async () => {
  const client = createQueryClient();
  let revision = 0;
  const base = modelSource("session");
  const source: TuiModelSource = {
    ...base,
    models: () =>
      Promise.resolve([
        {
          providerId: "fungi",
          providerName: "Fungi",
          id: `model-${String(revision)}`,
          name: "Fixture",
          reasoning: [],
        },
      ]),
    effectiveModel: async (signal) => ({
      ...(await base.effectiveModel(signal)),
      modelId: `model-${String(revision)}`,
    }),
  };
  try {
    expect((await client.query(modelCatalogQuery(source)))[0]?.id).toBe(
      "model-0",
    );
    expect((await client.query(effectiveModelQuery(source))).modelId).toBe(
      "model-0",
    );
    revision = 1;
    expect((await client.query(modelCatalogQuery(source)))[0]?.id).toBe(
      "model-1",
    );
    expect((await client.query(effectiveModelQuery(source))).modelId).toBe(
      "model-1",
    );
    expect(client.getQueryCache().getAll()).toHaveLength(2);
  } finally {
    client.clear();
  }
});

for (const kind of ["catalog", "effective"]) {
  test(`${kind} cancels the Local read when its cache entry is cancelled`, async () => {
    const client = createQueryClient();
    const started = Promise.withResolvers<undefined>();
    const aborted = Promise.withResolvers<undefined>();
    const held = Promise.withResolvers<undefined>();
    const observe = async (signal: AbortSignal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted.resolve(undefined);
        },
        { once: true },
      );
      started.resolve(undefined);
      await held.promise;
    };
    const base = modelSource("held-session");
    const source: TuiModelSource = {
      ...base,
      models: async (signal) => {
        await observe(signal);
        return base.models(signal);
      },
      effectiveModel: async (signal) => {
        await observe(signal);
        return base.effectiveModel(signal);
      },
    };
    // Observe rejection before cancellation so there is no unhandled promise.
    const outcomes = Promise.allSettled([
      kind === "catalog"
        ? client.query(modelCatalogQuery(source))
        : client.query(effectiveModelQuery(source)),
    ]);
    try {
      await started.promise;
      await client.cancelQueries({
        queryKey:
          kind === "catalog"
            ? modelCatalogQuery(source).queryKey
            : effectiveModelQuery(source).queryKey,
        exact: true,
      });
      await aborted.promise;
      const [outcome] = await outcomes;
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected")
        throw new Error("The cancelled read resolved");
      expect(outcome.reason).toBeInstanceOf(CancelledError);
    } finally {
      held.resolve(undefined);
      client.clear();
    }
  });
}

test("account observation waits for the effective Fungi model and reports a failed read without retrying", async () => {
  const client = createQueryClient();
  let calls = 0;
  const source: TuiModelSource = {
    ...modelSource("account-session"),
    account: {
      ...modelSource("account-session").account,
      owner: localAccountOwner(
        {
          auth: () => {
            calls++;
            return Promise.reject(new Error("Local account is unavailable"));
          },
        },
        () => [],
      ),
    },
  };
  const observer = new QueryObserver(
    client,
    modelAccessQuery(source, "openai"),
  );
  const failed = Promise.withResolvers<undefined>();
  const stop = observer.subscribe((result) => {
    if (result.isError) failed.resolve(undefined);
  });
  try {
    expect(calls).toBe(0);
    observer.setOptions(modelAccessQuery(source, "fungi"));
    await failed.promise;
    expect(calls).toBe(1);
    expect(observer.getCurrentResult().error?.message).toContain(
      "Local account is unavailable",
    );
  } finally {
    stop();
    client.clear();
  }
});
