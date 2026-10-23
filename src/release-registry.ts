import { z } from "zod";

export const releaseVersion = z
  .string()
  .max(128)
  .refine(
    (value) => Bun.semver.satisfies(value, ">=0.0.0-0"),
    "Expected a semantic release version",
  );
const release = z.object({ version: releaseVersion });

/** The registry owns latest; a short deadline also bounds reading its response body. */
export async function latestFungiVersion(
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    "https://registry.npmjs.org/@fungi.computer%2fspore/latest",
    {
      signal:
        signal === undefined
          ? AbortSignal.timeout(3_000)
          : AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok)
    throw new Error(`Fungi registry returned HTTP ${String(response.status)}`);
  return release.parse(await response.json()).version;
}
