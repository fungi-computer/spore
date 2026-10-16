import {
  createPrivateModels,
  defaultLocalModel,
  readFungiAccountStatus,
} from "@fungi.computer/truffle";
import type { LandingSummary } from "./landing.js";

/** The Fungi account and Team, and the model a new Session would start with. */
export async function readLandingSummary(
  signal: AbortSignal,
): Promise<LandingSummary> {
  const [login, model] = await Promise.all([
    readFungiAccountStatus(),
    defaultLocalModel(createPrivateModels(), signal),
  ]);
  return {
    account:
      login === undefined
        ? model === null
          ? undefined
          : `Signed in with ${model.providerId}`
        : `Fungi · ${login.team?.name ?? "no Team chosen"}`,
    model: model === null ? undefined : `${model.providerId}/${model.modelId}`,
  };
}
