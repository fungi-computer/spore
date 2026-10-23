import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import {
  createDesignTuiFixture,
  representativeDesignSnapshot,
} from "./design-fixture.js";
import { waitForFrame } from "./native-readiness.js";

test("failed compaction explains the cause without its internal code", async () => {
  const fixture = createDesignTuiFixture({
    snapshot: {
      ...representativeDesignSnapshot,
      messages: representativeDesignSnapshot.messages.slice(0, 1),
      compactions: [],
      compactionNotices: [
        {
          id: "failed-compaction",
          sequence: 3,
          at: 3,
          trigger: "manual",
          result: "failed",
          diagnostic: "model:rejected: Model acquisition failed",
        },
      ],
    },
  });
  const query = createQueryClient();
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        initialTheme="mocha"
      />
    </QueryClientProvider>,
    { width: 160, height: 30 },
  );
  try {
    const frame = await waitForFrame(setup, (value) =>
      value.includes("compaction failed"),
    );
    expect(frame).toContain("No model is available.");
    expect(frame).toContain("/login");
    expect(frame).not.toContain("model:rejected");
    expect(frame).not.toContain("Model acquisition failed");
  } finally {
    await destroyTestRenderer(setup);
    commands.close();
    query.clear();
    await fixture.waitForClose();
  }
});
