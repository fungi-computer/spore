import { z } from "zod";

const reasoningSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function parseReasoning(value: string | undefined) {
  if (value === undefined) return undefined;
  const decoded = reasoningSchema.safeParse(value);
  if (!decoded.success)
    throw new Error(
      "Invalid --reasoning value: " +
        value +
        ". Expected one of " +
        reasoningSchema.options.join(", "),
    );
  return decoded.data;
}
