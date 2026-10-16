import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SessionModelChoice,
  ModelAccountContext,
} from "@fungi.computer/parakeet/headless";
import type { ModelPreference } from "@fungi.computer/shiitake/model-preference";
import type { PrivateLocalEffectiveModel } from "@fungi.computer/truffle/service";

/** The model catalog and saved preference one frame shows. */
export type ModelSettings = Readonly<{
  models: readonly SessionModelChoice[];
  /** Undefined until observed; null means the owner's agent model. */
  current: ModelPreference | null | undefined;
  effective: PrivateLocalEffectiveModel | undefined;
  modelPreference: Readonly<{
    read: () => Promise<ModelPreference | null>;
    set: (preference: ModelPreference | null) => Promise<void>;
  }>;
  error?: string;
  /** Refresh the catalog and preference, e.g. after a save. */
  onOpen?: () => Promise<void>;
}>;

export type TuiModelSource = Readonly<{
  /** The same account owner and policy used by /login. */
  account: ModelAccountContext;
  /** Stable identity for the catalog provider, supplied by the host. */
  identity: string;
  models: (signal: AbortSignal) => Promise<readonly SessionModelChoice[]>;
  effectiveModel: (signal: AbortSignal) => Promise<PrivateLocalEffectiveModel>;
  modelPreference: ModelSettings["modelPreference"];
}>;

const emptyModels: readonly SessionModelChoice[] = [];

const preferenceKeys = new WeakMap<object, number>();
let nextPreferenceKey = 0;
function preferenceIdentity(owner: ModelSettings["modelPreference"]): number {
  const existing = preferenceKeys.get(owner);
  if (existing !== undefined) return existing;
  const identity = ++nextPreferenceKey;
  preferenceKeys.set(owner, identity);
  return identity;
}

/** Catalog identity is supplied by the selected Local Session host. */
export function modelCatalogQuery(source: TuiModelSource | undefined) {
  return queryOptions({
    queryKey: ["tui-model-catalog", source?.identity],
    queryFn: ({ signal }) => {
      if (source === undefined) throw new Error("Model source unavailable");
      return source.models(signal);
    },
    enabled: source !== undefined,
    // Reattaching must observe Local changes, even with Agar's cache defaults.
    staleTime: 0,
  });
}

/** Preference owners distinguish Sessions that share a catalog. */
export function modelPreferenceQuery(source: TuiModelSource | undefined) {
  return queryOptions({
    queryKey: [
      "tui-session-model-preference",
      source === undefined
        ? undefined
        : preferenceIdentity(source.modelPreference),
    ],
    queryFn: () => {
      if (source === undefined) throw new Error("Model source unavailable");
      return source.modelPreference.read();
    },
    enabled: source !== undefined,
    staleTime: 0,
  });
}

/** Effective selection comes from Local, never from the saved preference. */
export function effectiveModelQuery(source: TuiModelSource | undefined) {
  return queryOptions({
    queryKey: ["tui-effective-model", source?.identity],
    queryFn: ({ signal }) => {
      if (source === undefined) throw new Error("Model source unavailable");
      return source.effectiveModel(signal);
    },
    enabled: source !== undefined,
    staleTime: 0,
  });
}

/** Only Fungi's effective selection requires the account-access observation. */
export function modelAccessQuery(
  source: TuiModelSource | undefined,
  providerId: string | undefined,
) {
  return queryOptions({
    queryKey: ["tui-model-access", source?.identity],
    queryFn: ({ signal }) => {
      if (source === undefined) throw new Error("Model account unavailable");
      return source.account.owner.access(signal);
    },
    enabled: source !== undefined && providerId === "fungi",
    staleTime: 0,
  });
}

/** Read catalog and selected-session preference through the mounted QueryClient. */
export function useTuiModelSettings(
  source: TuiModelSource | undefined,
): ModelSettings | undefined {
  const queryClient = useQueryClient();
  const catalog = useQuery(modelCatalogQuery(source), queryClient);
  const preference = useQuery(modelPreferenceQuery(source), queryClient);
  const effective = useQuery(effectiveModelQuery(source), queryClient);
  if (source === undefined) return undefined;
  const error = catalog.error ?? preference.error ?? effective.error;
  const settings: ModelSettings = {
    models: catalog.data ?? emptyModels,
    current: preference.data,
    effective: effective.data,
    modelPreference: source.modelPreference,
    onOpen: async () => {
      // Reopening is the user's retry: preserve cached data while refreshing
      // both owners, including a catalog that failed on the first mount.
      await Promise.all([
        catalog.refetch(),
        preference.refetch(),
        effective.refetch(),
      ]);
    },
  };
  return error === null ? settings : { ...settings, error: error.message };
}
