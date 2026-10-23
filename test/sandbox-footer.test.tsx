import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import {
  createSandboxNoticeClaims,
  type TuiSandboxStatus,
} from "../src/button/local-sandbox.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";

const limitedClaim =
  "Limits what the agent's commands can change to your project folder and blocks their network access. They can still read other files on this computer, and this is not a security boundary against a hostile program.";
const unavailable: TuiSandboxStatus = {
  state: "unavailable",
  requireSandbox: false,
  reason: { kind: "missing", message: "Controlled backend unavailable" },
};

async function renderSandboxFooter(
  status: TuiSandboxStatus,
  agentId: string,
  sessionId: string,
  claim: ReturnType<typeof createSandboxNoticeClaims>,
) {
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
          identity: JSON.stringify([agentId, sessionId]),
          read: () => Promise.resolve(status),
          takeUnavailableNotice: () => claim(agentId, sessionId),
        }}
      />
    </QueryClientProvider>,
    { width: 160, height: 32 },
  );
  return {
    setup,
    close: async () => {
      act(() => {
        setup.renderer.destroy();
      });
      commands.close();
      query.clear();
      await fixture.waitForClose();
    },
  };
}

test("fallback notice is visible once per Agent/Session, not once per pane mount", async () => {
  const claim = createSandboxNoticeClaims();
  for (const [sessionId, shown] of [
    ["first", true],
    ["first", false],
    ["second", true],
  ] satisfies readonly (readonly [string, boolean])[]) {
    const frame = await renderSandboxFooter(
      unavailable,
      "agent",
      sessionId,
      claim,
    );
    try {
      await act(async () =>
        frame.setup.waitForFrame((text) => text.includes("UNSANDBOXED")),
      );
      // The longer literal wraps at ordinary terminal widths.
      const text = frame.setup.captureCharFrame().replace(/\s+/gu, " ");
      if (shown) {
        expect(text).toContain("Sandbox unavailable; running unsandboxed.");
        expect(text).toContain(limitedClaim);
        expect(text).toContain("Sandboxing, when available:");
      } else {
        expect(text).not.toContain("Sandbox unavailable; running unsandboxed.");
        expect(text).not.toContain(limitedClaim);
      }
    } finally {
      await frame.close();
    }
  }
});

for (const requireSandbox of [false, true]) {
  test(`available sandbox indicator is independent of requirement ${String(requireSandbox)}`, async () => {
    const frame = await renderSandboxFooter(
      { state: "available", requireSandbox },
      "agent",
      "session",
      createSandboxNoticeClaims(),
    );
    try {
      await act(async () =>
        frame.setup.waitForFrame((text) =>
          text.includes(requireSandbox ? "sandbox required" : "sandbox on"),
        ),
      );
      expect(frame.setup.captureCharFrame()).not.toContain("UNSANDBOXED");
      expect(frame.setup.captureCharFrame()).not.toContain(
        "running unsandboxed",
      );
    } finally {
      await frame.close();
    }
  });
}

test("notice custody distinguishes Agents as well as Sessions", () => {
  const claim = createSandboxNoticeClaims();
  expect(claim("agent-one", "session")).toBe(true);
  expect(claim("agent-one", "session")).toBe(false);
  expect(claim("agent-two", "session")).toBe(true);
  expect(claim("agent-one", "another-session")).toBe(true);
});

test("required unavailability is not labeled as fallback or allowed to consume its notice", async () => {
  const claim = createSandboxNoticeClaims();
  const required = await renderSandboxFooter(
    { ...unavailable, requireSandbox: true },
    "agent",
    "session",
    claim,
  );
  try {
    await act(async () =>
      required.setup.waitForFrame((text) =>
        text.includes("sandbox required · unavailable"),
      ),
    );
    expect(required.setup.captureCharFrame()).not.toContain(
      "running unsandboxed",
    );
  } finally {
    await required.close();
  }
  const fallback = await renderSandboxFooter(
    unavailable,
    "agent",
    "session",
    claim,
  );
  try {
    await act(async () =>
      fallback.setup.waitForFrame((text) =>
        text.replace(/\s+/gu, " ").includes(limitedClaim),
      ),
    );
    expect(fallback.setup.captureCharFrame()).toContain("running unsandboxed");
  } finally {
    await fallback.close();
  }
});
