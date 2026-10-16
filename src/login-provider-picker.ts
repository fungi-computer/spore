import process from "node:process";
import { isCancel, type Cli } from "@fungi.computer/lantern";
import {
  providerChoices,
  type ProviderAccess,
} from "@fungi.computer/parakeet/headless";
import {
  localLoginProviders,
  localPopularProviderIds,
} from "@fungi.computer/truffle/login";
import type { LocalAuthModels } from "@fungi.computer/truffle/auth";
import type { OneShotRunOptions } from "./one-shot-run.js";

/**
 * Present the same provider catalog and groups as /login before Pi's auth
 * flow. With an auth type, offer only providers with that kind of sign-in;
 * an API key never means the Fungi account.
 */
export async function chooseLoginProvider(
  cli: Pick<Cli, "search">,
  models: Pick<LocalAuthModels, "getProviders" | "checkAuth">,
  signals: OneShotRunOptions["signals"] = process,
  authType?: "oauth" | "api_key",
): Promise<string> {
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  try {
    const kind = authType === "oauth" ? "subscription" : authType;
    const providers = localLoginProviders(models.getProviders()).filter(
      (provider) =>
        kind === undefined ||
        (provider.methods.some((method) => method.kind === kind) &&
          !(kind === "api_key" && provider.id === "fungi")),
    );
    const access: ProviderAccess[] = [];
    for (const provider of providers) {
      controller.signal.throwIfAborted();
      const checked = await models.checkAuth(provider.id, {
        signal: controller.signal,
      });
      if (checked !== undefined)
        access.push({
          providerId: provider.id,
          providerName: provider.name,
          type: checked.type,
        });
    }
    controller.signal.throwIfAborted();
    const selected = await cli.search({
      message:
        authType === "api_key"
          ? "Which provider's API key?"
          : "Choose a provider",
      choices: providerChoices(
        providers,
        access,
        localPopularProviderIds,
        "login",
      ),
      collapsedGroup: "More providers",
      signal: controller.signal,
    });
    if (isCancel(selected)) throw new Error("Login cancelled.");
    return selected;
  } finally {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  }
}
