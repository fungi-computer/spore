import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Bun reads the home directory once at startup, so a test cannot isolate itself.
// Only `scripts/test-unit.mjs` starts bun with a throwaway HOME; a bare `bun test`
// would read the developer's real Fungi service and fail with LocalServiceUpdated.
if (!homedir().startsWith(join(tmpdir(), "fungi-tui-unit-home-")))
  throw new Error(
    "apps/tui tests need an isolated HOME. Run `pnpm --filter @fungi.computer/spore test:unit [file]` instead of bare `bun test`.",
  );
