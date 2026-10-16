import type { SessionMessage } from "@fungi.computer/shiitake/client";
import type { PrivateLocalServiceManager } from "@fungi.computer/truffle/service";
import type { SessionModelChoice } from "@fungi.computer/parakeet/headless";

/** Auth-status transport fixture for a catalog whose providers are configured. */
export function configuredModelAccess(
  models: readonly SessionModelChoice[],
): Awaited<ReturnType<PrivateLocalServiceManager["auth"]>> {
  return {
    kind: "status",
    providers: [
      ...new Map(models.map((model) => [model.providerId, model])).values(),
    ].map((model) => ({
      providerId: model.providerId,
      providerName: model.providerName,
      state: "configured",
      type: "api_key",
    })),
  };
}

/** A durable assistant reply: the footer labels this model, not the next-turn preference. */
export function modelHistory(
  provider: string,
  model: string,
): readonly SessionMessage[] {
  return [
    {
      id: "model-history",
      commandId: "model-history-turn",
      sequence: 1,
      value: {
        role: "assistant",
        api: "pi",
        provider,
        model,
        content: [{ type: "text", text: "Saved conversation." }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    },
  ];
}
