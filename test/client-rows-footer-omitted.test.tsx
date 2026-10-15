// An extension's retained-event notice and null-anchor rows join its own
// footer entry; one with no panel or chip row keeps none of this, rather
// than growing a block -- or the old separate "Extension changes" section
// -- just to show it.
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createQueryClient } from "@fungi.computer/agar/query";
import { QueryClientProvider } from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import { defineClientEntry } from "@fungi.computer/shiitake/client-entry";
import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";

const silentEntry = defineClientEntry(
  {
    id: ExtensionId.make("silent-footer"),
    commands: {},
    projection: { schema: Schema.String },
  },
  {
    // No panel, no chips: this extension has no footer slot at all. Its
    // retained-event notice and null-anchor row must never grow one.
    contribute: () => ({
      chips: [],
      panel: [],
      timeline: {
        cells: [
          {
            id: "1",
            sequence: 1,
            at: 1,
            commandId: null,
            rows: [{ id: "orphan", title: "Orphan committed row" }],
          },
        ],
        omitted: 5,
      },
      waiting: null,
    }),
  },
);

test("drops a footerless extension's omitted notice and unanchored rows entirely", async () => {
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const query = createQueryClient();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        session={fixture.session}
        clients={[silentEntry]}
        commands={commands}
      />
    </QueryClientProvider>,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => setup.renderOnce());
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("earlier changes omitted");
    expect(frame).not.toContain("Orphan committed row");
    expect(frame).not.toContain("Extension changes");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    query.clear();
    commands.close();
  }
});
