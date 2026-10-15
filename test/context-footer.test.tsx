import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fauxModelSource, memoryHost } from "@fungi.computer/shiitake/testing";
import { formatContextUsage } from "@fungi.computer/parakeet/headless";
import { TuiFrame } from "../src/frame.js";
import { captureFrame } from "./frame-capture.js";
import { footerRow } from "./footer-row.js";

const wide = { providerId: "faux", modelId: "wide" } as const;

for (const width of [80, 160]) {
  test(`the footer shows the Session's context use after a turn and the new max after /model (${String(width)})`, async () => {
    // A real Session owner: compaction's own figure and the host's window.
    // One scripted reply per run, in order.
    const replies = [
      fauxModelSource([
        fauxAssistantMessage("The forage notes list three morel spots."),
      ]),
      fauxModelSource([
        fauxAssistantMessage(
          "The north ridge spot is the oldest, recorded over four springs.",
        ),
      ]),
    ];
    let runs = 0;
    const host = await memoryHost({
      model: {
        acquire: (input) => {
          const reply = replies[Math.min(runs, replies.length - 1)];
          runs += 1;
          if (reply === undefined) throw new Error("No scripted reply");
          return reply.acquire(input);
        },
        describe: ({ preference }) =>
          Promise.resolve({
            contextWindow: preference?.modelId === "wide" ? 1_000_000 : 200_000,
          }),
      },
    });
    const session = host.agent.session(`context-footer-${String(width)}`);
    const sessionId = `context-footer-${String(width)}`;
    const query = createQueryClient();
    const commands = createWhistle();
    await session.send("Where are the morels?", { requestId: "first" });
    await host.settle(sessionId);
    const setup = await testRender(
      <QueryClientProvider client={query}>
        <TuiFrame session={session} commands={commands} initialTheme="mocha" />
      </QueryClientProvider>,
      { width, height: 24 },
    );
    const output = process.env.TUI_CONTEXT_FOOTER_CAPTURE_DIR;
    /** The footer's context use once it reads the owner's current figure. */
    const shows = async (name: string) => {
      const context = (await session.read()).context;
      if (context === undefined) throw new Error("No context reported");
      const text = formatContextUsage(context);
      // Live frames arrive from the owner's observation stream in real time.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          await setup.renderOnce();
        });
        if (footerRow(setup.captureCharFrame(), "idle")?.includes(`· ${text}`))
          break;
      }
      expect(footerRow(setup.captureCharFrame(), "idle")).toContain(
        `· ${text}`,
      );
      await captureFrame(
        setup,
        output,
        `context-footer-${String(width)}-${name}`,
      );
      return context;
    };
    try {
      const first = await shows("first-turn");
      expect(first.window).toBe(200_000);

      // Another turn: the footer follows the context compaction now measures.
      await session.send("Which is the oldest?", { requestId: "second" });
      await host.settle(sessionId);
      const second = await shows("second-turn");
      expect(second.tokens).toBeGreaterThan(first.tokens);

      // /model while idle: the new selection's window, before any run.
      await session.modelPreference.set(wide);
      const switched = await shows("after-model");
      expect(switched).toEqual({ tokens: second.tokens, window: 1_000_000 });
      expect(footerRow(setup.captureCharFrame(), "idle")).toContain("/1M");
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      query.clear();
      commands.close();
      await host.close();
    }
  });
}
