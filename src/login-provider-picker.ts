import process from "node:process";
import { isCancel, type Cli } from "@fungi.computer/lantern";
import {
  providerChoices,
  type ProviderAccess,
} from "@fungi.computer/parakeet/headless";
import {
  localLoginProviders,
  localPopularProviderIds,
} from "@fungi.computer/local/login";
import type { LocalAuthModels } from "@fungi.computer/local/auth";
import type { OneShotRunOptions } from "./one-shot-run.js";

/** Present the same provider catalog and groups as /login before Pi's auth flow. */
export async function chooseLoginProvider(
  cli: Pick<Cli, "search">,
  models: Pick<LocalAuthModels, "getProviders" | "checkAuth">,
  signals: OneShotRunOptions["signals"] = process,
): Promise<string> {
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  try {
    const providers = localLoginProviders(models.getProviders());
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
      message: "Choose a provider",
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
