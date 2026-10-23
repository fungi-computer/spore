import assert from "node:assert/strict";
import process from "node:process";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "@fungi.computer/spore/frame";
import { act, createElement } from "react";
import { RGBA } from "@opentui/core";
import { terminalPalette } from "@fungi.computer/stipe";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";

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
  const palette = terminalPalette("mocha");
  for (const [pattern, color] of [
    [/^ +Read apps\/tui\/src\/frame\.tsx +42ms ● ▸ *$/u, palette.success],
    [/^ +Running pnpm --dir apps\/tui run typecheck +● ▸ *$/u, palette.info],
  ]) {
    const row = setup
      .captureSpans()
      .lines.find((line) =>
        pattern.test(line.spans.map((span) => span.text).join("")),
      );
    assert.ok(row, `Missing completed/active tool row: ${pattern}`);
    const dot = row.spans.find((span) => span.text.includes("●"));
    assert.ok(dot, "Each tool row keeps its trailing status dot.");
    assert.deepEqual(dot.fg.toInts(), RGBA.fromHex(color).toInts());
  }
} finally {
  await destroyTestRenderer(setup);
  client.clear();
  commands.close();
}
await fixture.waitForClose();
process.stdout.write(
  "Packed running tool group shows completed and active calls.\n",
);
