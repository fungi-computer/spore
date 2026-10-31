import type { z } from "zod";
import type { ReleasePackages } from "../../../tooling/release/data-impact.mjs";

export type UpgradeReport = {
  from: ReleasePackages[];
  checks: { name: string; from: string; status: "pass" | "fail" }[];
};
export const upgradeReportSchema: z.ZodType<UpgradeReport>;
