import { z } from "zod";
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
