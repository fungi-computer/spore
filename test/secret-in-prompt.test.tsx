import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { memoryHost } from "@fungi.computer/shiitake/testing";
import { TuiFrame } from "../src/frame.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";

/** Provider-shaped, as gitleaks' default rules know it; never a real token. */
const pastedKey = ["ghp_", "7Zk9P2mQa4Wv6Xc8Bn0Ds3Fg5Hj1Lr9Ty2Ui"].join("");

test("a pasted key is refused at intake with a toast pointing at /login, and nothing is stored", async () => {
  // A real Session owner: the refusal is Shiitake's, the toast Parakeet's.
  const host = await memoryHost();
  const sessionId = "secret-in-prompt";
  const session = host.agent.session(sessionId);
  await host.agent.createSession(sessionId);
  const query = createQueryClient();
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame session={session} commands={commands} />
    </QueryClientProvider>,
    { width: 100, height: 24 },
  );
  try {
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
    await act(async () => {
      await setup.mockInput.typeText(`deploy with ${pastedKey}`);
    });
    await waitForFrame(setup, (frame) => frame.includes("deploy with"));
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    await waitForFrame(setup, (frame) => frame.includes("Not sent"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("› Add it with /login");
    // The text is back in the composer to edit; no prompt row was drawn.
    expect(frame).toContain("deploy with");
    const snapshot = await act(async () => session.read());
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.terminals).toEqual([]);
  } finally {
    await destroyTestRenderer(setup);
    query.clear();
    commands.close();
    await host.close();
  }
});
