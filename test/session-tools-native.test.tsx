import { mkdir } from "node:fs/promises";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  QueryClient,
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { act } from "react";
import { sigilGutterText } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture, fixtureClients } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";

test("renders a checklist and waiting-loop footer at 80 and 120 columns", async () => {
  notifyManager.setScheduler(queueMicrotask);
  try {
    for (const width of [80, 120]) {
      const fixture = createTuiFixture({
        goal: {
          revision: "run:one",
          objective: "Check",
          state: "paused",
          stopReason: "Stalled: no progress for 3 turns",
        },
        loop: {
          loopId: "one",
          origin: "model",
          expiresAt: null,
          prompt: "Check",
          mode: "self_paced",
          cron: null,
          state: "active",
          commandId: "one",
          reason: "Waiting on CI",
          nextDueAt: 1000,
          lastError: null,
        },
        plan: {
          steps: [
            { step: "Read the source", status: "completed" },
            { step: "Verify the change", status: "in_progress" },
          ],
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
        { width, height: 24 },
      );
      try {
        await act(async () => setup.renderOnce());
        await act(async () =>
          setup.waitForFrame((frame) =>
            frame.includes("Verify the change · 2/2"),
          ),
        );
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Goal · paused");
        expect(frame).toContain("Stalled: no progress for 3 turns");
        expect(frame).not.toContain("Esc stop loop");
        const loopRows = frame
          .split("\n")
          .filter((line) => line.includes("Loop · active · self-paced"));
        expect(loopRows).toHaveLength(1);
        expect(loopRows[0]).toContain("Next 1970-01-01 00:00:01.000Z");
        expect(frame).not.toContain("Read the source");
        await act(async () => setup.mockInput.typeText("/plan"));
        act(() => {
          setup.mockInput.pressKey("RETURN");
        });
        await act(async () =>
          setup.waitForFrame((value) =>
            value.includes(`${sigilGutterText("●")}Read the source`),
          ),
        );
        expect(setup.captureCharFrame()).toContain(
          `${sigilGutterText("●")}Verify the change`,
        );
        expect(setup.captureCharFrame()).not.toContain("✔");
        const output = process.env.SESSION_TOOLS_CAPTURE_DIR;
        if (output !== undefined) {
          await mkdir(output, { recursive: true });
          await captureFrame(setup, output, "session-tools-" + String(width));
        }
      } finally {
        act(() => {
          setup.renderer.destroy();
        });
        commands.close();
        client.clear();
        await fixture.waitForClose();
      }
    }
  } finally {
    notifyManager.setScheduler(defaultScheduler);
  }
});
