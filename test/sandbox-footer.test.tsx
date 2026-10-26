import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import type { TuiSandboxStatus } from "../src/button/local-sandbox.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";

for (const [mode, label] of [
  ["full-access", "full access"],
  ["workspace", "workspace · sandboxed"],
  ["read-only", "read-only · sandboxed"],
] satisfies readonly (readonly [TuiSandboxStatus["mode"], string])[]) {
  test(`footer shows ${mode} without a fallback notice`, async () => {
    const fixture = createTuiFixture({ messages: [] });
    const query = createQueryClient();
    const commands = createWhistle();
    const setup = await testRender(
      <QueryClientProvider client={query}>
        <TuiFrame
          session={fixture.session}
          commands={commands}
          initialTheme="mocha"
          sandboxSource={{
            identity: "agent/session",
            read: () =>
              Promise.resolve<TuiSandboxStatus>(
                mode === "full-access"
                  ? {
                      mode,
                      available: false,
                      reason: { kind: "install", message: "No bwrap" },
                    }
                  : { mode, available: true },
              ),
          }}
        />
      </QueryClientProvider>,
      { width: 160, height: 32 },
    );
    try {
      await act(async () => setup.waitForFrame((text) => text.includes(label)));
      expect(setup.captureCharFrame()).not.toContain("running unsandboxed");
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      commands.close();
      query.clear();
      await fixture.waitForClose();
    }
  });
}
