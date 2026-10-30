import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

const { dependencies, devDependencies } = z
  .object({
    dependencies: z.record(z.string(), z.string()),
    devDependencies: z.record(z.string(), z.string()),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ),
  );

test("the production Local deploy includes Truffle", () => {
  expect(dependencies["@fungi.computer/truffle"]).toBe("workspace:*");
  expect(devDependencies["@fungi.computer/truffle"]).toBeUndefined();
});
