import assert from "node:assert/strict";
import process from "node:process";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "@fungi.computer/spore/frame";
import { act, createElement } from "react";

import {
  createDesignTuiFixture,
  runningToolsDesignSnapshot,
} from "./design-fixture.ts";

const fixture = createDesignTuiFixture({
  snapshot: runningToolsDesignSnapshot,
});
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const commands = createWhistle();
const setup = await testRender(
  createElement(
    QueryClientProvider,
    { client },
    createElement(TuiFrame, {
      commands,
      session: fixture.session,
      initialTheme: "mocha",
    }),
  ),
  { width: 100, height: 48 },
);
try {
  await act(async () => {
    await setup.renderOnce();
    await setup.waitForFrame((frame) =>
      frame.includes("Running pnpm --dir apps/tui run typecheck"),
    );
  });
  const frame = setup.captureCharFrame();
  assert.match(frame, /5 calls/u);
  assert.match(frame, /✓ Read apps\/tui\/src\/frame\.tsx/u);
  assert.match(frame, /◌ Running pnpm --dir apps\/tui run typecheck/u);
} finally {
  await act(async () => setup.renderer.destroy());
  client.clear();
  commands.close();
}
await fixture.waitForClose();
process.stdout.write(
  "Packed running tool group shows completed and active calls.\n",
);
