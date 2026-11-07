import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { z } from "zod";
import { claimsSchema } from "../../../tooling/release/changelog-claims.mjs";
import { releasePackagesSchema } from "../../../tooling/release/data-impact.mjs";

/** Shared proof output. Consumers decode this schema, never a second shape. */
export const upgradeReportSchema = z.strictObject({
  from: z.array(releasePackagesSchema),
  checks: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1),
        from: z.string().min(1),
        status: z.enum(["pass", "fail"]),
      }),
    )
    .min(1, "upgrade proof selected zero checks"),
});

/**
 * Reviewed resets an upgrade from baseline Fungi to this candidate crosses for
 * the Local Session store. The candidate's release number is the checkout's
 * stamped tooling/release/fungi-version.json; only claims of releases in
 * (baseline, candidate] count, and only an effective reset that declares
 * covers "local-session". A superseded claim has dropped its reset, and an
 * undesignated reset (a Hub store) or a later release never applies.
 */
export function declaredLocalSessionResets(checkout, baselineFungi) {
  const candidate = z
    .object({ version: z.string().refine((v) => semver.valid(v) === v) })
    .parse(
      JSON.parse(
        readFileSync(
          join(checkout, "tooling/release/fungi-version.json"),
          "utf8",
        ),
      ),
    ).version;
  if (!semver.gt(candidate, baselineFungi))
    throw new Error(
      `candidate Fungi ${candidate} is not newer than baseline ${baselineFungi}`,
    );
  const directory = join(checkout, "apps/docs/release-claims");
  const versions = readdirSync(directory)
    .filter((name) => /^\d+\.\d+\.\d+\.json$/u.test(name))
    .map((name) => name.slice(0, -".json".length));
  if (!versions.includes(candidate))
    throw new Error(
      `candidate Fungi ${candidate} has no release-claims document`,
    );
  return versions
    .filter(
      (version) =>
        semver.gt(version, baselineFungi) && semver.lte(version, candidate),
    )
    .sort(semver.compare)
    .flatMap((version) => {
      const document = claimsSchema.parse(
        JSON.parse(readFileSync(join(directory, `${version}.json`), "utf8")),
      );
      if (document.version !== version)
        throw new Error(
          `release-claims/${version}.json declares ${document.version}`,
        );
      return Object.entries(document.claims)
        .filter(
          ([, claim]) =>
            claim.kind === "behaviour" &&
            claim.reset?.covers?.includes("local-session") === true,
        )
        .map(([id, claim]) => ({ version, id, reset: claim.reset }));
    });
}
