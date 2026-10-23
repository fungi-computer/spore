import { formatModelWithLevel } from "@fungi.computer/parakeet/headless";
import type { Models } from "@earendil-works/pi-ai";
import {
  type PrivateLocalAgentChoice,
  readFungiAccountStatus,
  resolveAgentStartupModel,
} from "@fungi.computer/truffle";
import type { LandingSummary } from "./landing.js";

/**
 * The Fungi account and Team, and the model a new Session would start with.
 * No Agent yet means a new Agent; one Agent is the Agent the new chat uses;
 * several Agents leave the choice to the person, so no single model is shown.
 */
export async function readLandingSummary(
  models: Models,
  agents: readonly Pick<PrivateLocalAgentChoice, "databasePath">[],
  signal: AbortSignal,
  options: { credentialPath?: string } = {},
): Promise<LandingSummary> {
  const [login, model] = await Promise.all([
    readFungiAccountStatus(options),
    agents.length > 1
      ? null
      : resolveAgentStartupModel({
          models,
          databasePath: agents[0]?.databasePath,
          signal,
        }),
  ]);
  return {
    account:
      login === undefined
        ? model === null
          ? undefined
          : `Signed in with ${model.providerId}`
        : `Fungi · ${login.team?.name ?? "no Team chosen"}`,
    model:
      model === null
        ? undefined
        : formatModelWithLevel(
            { provider: model.providerId, model: model.modelId },
            model.reasoning,
          ),
  };
}
