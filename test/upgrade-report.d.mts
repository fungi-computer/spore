import type { z } from "zod";
import type { ReleasePackages } from "../../../tooling/release/data-impact.mjs";

export type UpgradeReport = {
  from: ReleasePackages[];
  checks: { name: string; from: string; status: "pass" | "fail" }[];
};
export const upgradeReportSchema: z.ZodType<UpgradeReport>;

export type DeclaredLocalSessionReset = {
  version: string;
  id: string;
  reset: {
    kind: "reset" | "archive";
    lost: string;
    recovery: string;
    covers?: "local-session"[];
  };
};
/** Reviewed Local Session resets crossed by an upgrade from this baseline. */
export function declaredLocalSessionResets(
  checkout: string,
  baselineFungi: string,
): DeclaredLocalSessionReset[];
