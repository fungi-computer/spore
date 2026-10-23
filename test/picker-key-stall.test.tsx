import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const proof = fileURLToPath(
  new URL("./picker-key-stall.native.tsx", import.meta.url),
);

// Raw-key timing belongs to the real application root, not the component test
// SDK's extra root and act environment. Keep every key/render unbatched in an
// isolated process; inherit output so the diagnostic guard still sees it all.
function nativeScenario(scenario: "repeat" | "notice") {
  const result = spawnSync(
    process.execPath,
    ["run", proof, "--scenario", scenario],
    { stdio: "inherit", timeout: 60_000 },
  );
  if (result.error) throw result.error;
  expect(result.status).toBe(0);
}

test("Ctrl K o opens a picker that takes keys every time (20 opens)", () => {
  nativeScenario("repeat");
}, 60_000);

test("Esc clears a shell notice under the real keymap", () => {
  nativeScenario("notice");
}, 60_000);
