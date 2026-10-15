import { mkdir } from "node:fs/promises";
import process from "node:process";
import { expect, test } from "bun:test";
import { act } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { sigilGutterText } from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture, fixtureClients } from "./fixture.js";
import { captureFrame } from "./frame-capture.js";

const idleStatus = `${sigilGutterText("●")}idle`;

for (const { width, height } of [
  { width: 80, height: 24 },
  { width: 160, height: 48 },
]) {
  for (const active of [false, true]) {
    test(`Goal and Loop rows ${active ? "active" : "inactive"} at ${String(width)}x${String(height)}`, async () => {
      notifyManager.setScheduler(queueMicrotask);
      const fixture = createTuiFixture({
        goal: active
          ? {
              revision: "footer-goal",
              objective: "Keep the menus tidy",
              state: "active",
              stopReason: null,
            }
          : null,
        loop: active
          ? {
              loopId: "footer-loop",
              origin: "human",
              expiresAt: null,
              prompt: "Check the menus",
              mode: "self_paced",
              cron: null,
              state: "active",
              commandId: "footer-work",
              reason: "Waiting",
              nextDueAt: Date.parse("2026-10-09T12:00:00Z"),
              lastError: null,
            }
          : null,
      });
      const query = createQueryClient();
      const commands = createWhistle();
      const setup = await createTestRenderer({ width, height });
      const palette = {
        palette: [
          "#000000",
          "#cd3131",
          "#0dbc79",
          "#e5e510",
          "#2472c8",
          "#bc3fbc",
          "#11a8cd",
          "#e5e5e5",
          "#666666",
          "#f14c4c",
          "#23d18b",
          "#f5f543",
          "#3b8eea",
          "#d670d6",
          "#29b8db",
          "#ffffff",
        ],
        defaultForeground: "#cccccc",
        defaultBackground: "#1e1e1e",
        cursorColor: "#cccccc",
        mouseForeground: "#cccccc",
        mouseBackground: "#1e1e1e",
        tekForeground: "#cccccc",
        tekBackground: "#1e1e1e",
        highlightForeground: "#ffffff",
        highlightBackground: "#264f78",
      };
      setup.renderer.getPalette = () => Promise.resolve(palette);
      const root = createRoot(setup.renderer);
      act(() => {
        root.render(
          <QueryClientProvider client={query}>
            <TuiFrame
              initialTheme="terminal"
              session={fixture.session}
              commands={commands}
              clients={fixtureClients}
            />
          </QueryClientProvider>,
        );
      });
      try {
        await act(async () =>
          setup.waitForFrame((frame) =>
            active
              ? frame.includes("Loop · active")
              : frame.includes(idleStatus),
          ),
        );
        const output = process.env.TUI_ORGANIZATION_CAPTURE_DIR;
        if (output !== undefined) {
          await mkdir(output, { recursive: true });
          await captureFrame(
            setup,
            output,
            `extension-rows-${active ? "active" : "inactive"}-${String(width)}x${String(height)}`,
          );
        }
        const footer = setup
          .captureCharFrame()
          .split("\n")
          .find((line) => line.includes(idleStatus));
        expect(footer).not.toContain("Goal");
        expect(footer).not.toContain("Loop");
        expect(footer).not.toContain("auto");
        expect(footer).not.toContain("PgUp/PgDn scroll");
        expect(footer).not.toContain("tool group");
        const frame = setup.captureCharFrame();
        const goalRows = frame
          .split("\n")
          .filter((line) => line.includes("Goal · active"));
        const loopRows = frame
          .split("\n")
          .filter((line) => line.includes("Loop · active"));
        expect(goalRows).toHaveLength(active ? 1 : 0);
        expect(loopRows).toHaveLength(active ? 1 : 0);
        if (active) {
          expect(frame.indexOf("Goal · active")).toBeGreaterThan(
            frame.indexOf(idleStatus),
          );
          expect(footer).not.toContain("Esc");
        }
      } finally {
        act(() => {
          root.unmount();
          setup.renderer.destroy();
        });
        commands.close();
        query.clear();
        await fixture.waitForClose();
        notifyManager.setScheduler(defaultScheduler);
      }
    });
  }
}
