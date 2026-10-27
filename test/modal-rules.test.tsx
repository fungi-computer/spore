import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { WhistlePrompt } from "@fungi.computer/whistle";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { runProducer } from "./modal-producers.js";
import { collectRestPrompts, commandRuns } from "./modal-prompts.js";

/** What the real Goal, Loop, Skills and question commands show. */
const restPrompts = await collectRestPrompts();

/** The longest title a modal carries (design rule 1). */
const titleLimit = 60;

/**
 * Confirmations that are harmless and so focus the action by design: the
 * answer undoes nothing and costs nothing to repeat.
 */
const harmlessConfirmations: readonly string[] = [];

/** Every prompt the real producers send, each command run for real. */
async function everyPrompt() {
  const runs = [
    await runProducer("archive", []),
    await runProducer("archive", ["agent_k5f8x2"]),
    await runProducer("extensions", []),
    await runProducer("extensions", ["add"]),
    await runProducer("extensions", ["disable"]),
    await runProducer("extensions", ["disable", "project"]),
    await runProducer("extensions", ["remove"]),
    await runProducer("extensions", ["remove", "acme-tools"]),
    ...(await commandRuns()),
  ];
  for (const run of runs) run.stop();
  const real = runs.flatMap((run) => run.prompts);
  return [...real, ...Object.values(restPrompts)] satisfies WhistlePrompt[];
}

test("no producer's title is longer than 60 characters", async () => {
  const prompts = await everyPrompt();
  expect(prompts.length).toBeGreaterThan(10);
  for (const prompt of prompts)
    expect(prompt.message.length, prompt.message).toBeLessThanOrEqual(
      titleLimit,
    );
});

test("no confirmation focuses its confirm label", async () => {
  const confirmations = (await everyPrompt()).filter(
    (prompt) => prompt.type === "confirmation",
  );
  expect(confirmations.length).toBeGreaterThanOrEqual(3);
  for (const prompt of confirmations) {
    const confirm = prompt.confirmLabel ?? "Confirm";
    const host = createWhistleInteractionHost({ title: "Rules" });
    void host.begin().interaction.prompt(prompt);
    function Frame() {
      const { colors } = useTerminalTheme("mocha");
      return (
        <DialogSurface colors={colors} onClose={() => undefined}>
          <InteractionView
            host={host}
            colors={colors}
            onClose={() => undefined}
          />
        </DialogSurface>
      );
    }
    const setup = await testRender(<Frame />, { width: 80, height: 24 });
    for (let pass = 0; pass < 3; pass += 1)
      await act(async () => setup.renderOnce());
    try {
      const focused = setup
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("▶"));
      expect(focused, prompt.message).toBeDefined();
      if (!harmlessConfirmations.includes(prompt.message))
        expect(focused, prompt.message).not.toContain(confirm);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  }
});
