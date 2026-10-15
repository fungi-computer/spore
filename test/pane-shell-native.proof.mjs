import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import { createDesignTuiFixture } from "./design-fixture.js";
import { captureFrame } from "./frame-capture.js";
import { waitForFrame } from "./native-readiness.js";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

for (const [width, height] of [
  [80, 24],
  [160, 48],
]) {
  if (width === undefined || height === undefined)
    throw new Error("Viewport missing");
  const fixture = createDesignTuiFixture();
  const commands = createWhistle();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const setup = await testRender(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TuiFrame, {
        session: fixture.session,
        commands,
        initialTheme: "mocha",
      }),
    ),
    { width, height },
  );
  try {
    await waitForFrame(
      setup,
      () =>
        setup.captureCharFrame().includes("Ask anything") &&
        setup.captureCharFrame().includes("streaming"),
    );
    await captureFrame(
      setup,
      process.env.PANE_CAPTURE_DIR,
      `conversation-${width}x${height}`,
    );
    assert.match(setup.captureCharFrame(), /Ask anything/u);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    commands.close();
    client.clear();
    await fixture.waitForClose();
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
console.log("pane-shell native conversation frames PASS (80x24, 160x48)");
