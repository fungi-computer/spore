import { representativeDesignSnapshot } from "./design-fixture.js";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { act } from "react";

import {
  createTuiFixture,
  fixtureClients,
  fixtureGoalStartedAt,
} from "./fixture.js";
import { sigilGutterText } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import { rendererInteraction } from "../src/renderer-interaction.js";

// The gutter's own leading pad is still leading whitespace on the line, so
// it trims away with trimStart(); only the mark-to-text gap stays.
const idleStatus = `${sigilGutterText("●").trimStart()}idle`;

/** The main status/hints footer, before the extension rows and notices. */
function footer(frame: string): string {
  return (
    frame
      .split("\n")
      .find(
        (line) =>
          line.trimStart().startsWith(idleStatus) ||
          line.trimStart().startsWith("idle "),
      ) ?? ""
  );
}

test("the goal indicator survives resizing the pane between widths", async () => {
  const fixture = createTuiFixture({
    messages: representativeDesignSnapshot.messages.map((message) =>
      message.value.role === "assistant"
        ? {
            ...message,
            value: { ...message.value, model: "gpt-6-sol", provider: "openai" },
          }
        : message,
    ),
    goal: {
      revision: "resize-goal",
      objective: "Keep the footer honest",
      state: "active",
      startedAt: fixtureGoalStartedAt,
      pauseCause: null,
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        initialTheme="mocha"
        clients={fixtureClients}
        session={fixture.session}
        commands={commands}
      />
    </QueryClientProvider>,
    { width: 48, height: 20, ...rendererInteraction },
  );
  try {
    await act(async () => setup.renderOnce());
    await act(async () =>
      setup.waitForFrame(
        (frame) =>
          frame.includes("Pursuing goal since") &&
          footer(frame).includes("openai/gpt-6-sol"),
      ),
    );
    for (const width of [80, 100, 60, 48, 140, 90]) {
      await act(async () => {
        setup.resize(width, 20);
        await setup.renderOnce();
      });
      await act(async () =>
        setup.waitForFrame(
          (frame) =>
            frame.includes("Pursuing goal since") &&
            footer(frame).includes("openai/gpt-6-sol"),
        ),
      );
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Pursuing goal since");
      expect(frame.indexOf(footer(frame))).toBeLessThan(
        frame.indexOf("Pursuing goal since"),
      );
      expect(footer(frame), `width ${String(width)}\n${frame}`).toContain(
        "openai/gpt-6-sol",
      );
      expect(footer(setup.captureCharFrame())).not.toContain("Alt+Enter");
    }
  } finally {
    await destroyTestRenderer(setup);
    commands.close();
    client.clear();
    await fixture.waitForClose();
  }
});
