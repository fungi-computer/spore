import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  WhistleContributionLease,
  WhistleRuntime,
} from "@fungi.computer/whistle";
import { sessionModelCommandDefinitions } from "@fungi.computer/parakeet/headless";
import {
  effectiveModelQuery,
  modelAccessQuery,
  useTuiModelSettings,
  type TuiModelSource,
} from "./model-query.js";
import { fungiModelLoginNotice } from "./login-notice.js";

/**
 * Own model observation and the host's `/model` and `/thinking` contribution.
 * Parakeet's model commands ask their questions through the interaction the
 * frame already draws, so there is no terminal model picker.
 */
export function useModelControls({
  source,
  commands,
}: Readonly<{
  source: TuiModelSource | undefined;
  commands: Pick<WhistleRuntime, "contribute">;
}>) {
  const settings = useTuiModelSettings(source);
  const access = useQuery(
    modelAccessQuery(source, settings?.effective?.providerId),
  );
  // Local status, not catalog availability, decides whether sign-in is missing.
  const loginNotice =
    settings?.effective?.providerId === "fungi" &&
    access.isSuccess &&
    !access.data.some((provider) => provider.providerId === "fungi")
      ? fungiModelLoginNotice
      : undefined;
  const preference = source?.modelPreference;
  const lease = useRef<WhistleContributionLease | undefined>(undefined);
  useEffect(() => {
    if (preference === undefined) return;
    const active = commands.contribute({
      sourceId: "tui-session",
      namespace: "session",
      commands: [],
    });
    lease.current = active;
    return () => {
      active.dispose();
      lease.current = undefined;
    };
  }, [commands, preference]);
  const refresh = settings?.onOpen;
  useEffect(() => {
    if (settings === undefined || source === undefined) return;
    const owner = settings.modelPreference;
    lease.current?.update(
      sessionModelCommandDefinitions(
        {
          modelPreference: {
            read: owner.read,
            set: async (next) => {
              await owner.set(next);
              // Refresh the observed settings after a save.
              await refresh?.();
            },
          },
        },
        {
          account: source.account,
          sourceId: "tui-session",
          namespace: "session",
          models: settings.models,
          refreshModels: source.models,
        },
      ),
    );
  }, [commands, preference, settings?.models, source?.account]);
  // The footer names the selection as soon as Local reports it, not the
  // model of the last reply; a save above refreshes this observation.
  const effective = settings?.effective;
  const selectedModel =
    effective === undefined
      ? undefined
      : { provider: effective.providerId, model: effective.modelId };
  // The same observation the footer's model selection reads; shares its cache.
  const effectiveModel = useQuery(effectiveModelQuery(source));
  const signInRequired =
    selectedModel === undefined ||
    effectiveModel.data?.credential.kind === "missing" ||
    loginNotice !== undefined;
  return { loginNotice, selectedModel, refresh, signInRequired };
}
