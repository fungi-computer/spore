import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
import { createQueryClient } from "@fungi.computer/agar/query";
import {
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from "@tanstack/react-query";
import { createWhistle } from "@fungi.computer/whistle";
import type { WhistleCatalogStepV1 } from "@fungi.computer/whistle/catalog";
import type { Json } from "@fungi.computer/shiitake/extensions";
import type { ParakeetSession } from "@fungi.computer/parakeet/headless";
import type { SessionExtensionSlots } from "@fungi.computer/shiitake/client";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";

const project = "/work/.agents/skills";
const personal = "/home/fixture/.agents/skills";

// The wire reply of the skills extension's `/skills` command.
const listing = {
  type: "prompt",
  prompt: {
    type: "choice",
    message: "2 skills discovered",
    options: [
      {
        value: "botanical-retention",
        label: "botanical-retention",
        description: `${project}/botanical-retention/SKILL.md`,
      },
      {
        value: "herdr",
        label: "herdr",
        description: `${personal}/herdr/SKILL.md`,
      },
    ],
  },
  next: { arguments: {}, answer: "name" },
} satisfies WhistleCatalogStepV1 & Json;
const details = {
  type: "done",
  notice: {
    type: "info",
    message: `herdr\nCoordinate teams\n${personal}/herdr/SKILL.md`,
  },
} satisfies WhistleCatalogStepV1 & Json;

test("/skills lists each discovered skill beside the file it came from", async () => {
  notifyManager.setScheduler(queueMicrotask);
  const fixture = createTuiFixture();
  const calls: [string, unknown][] = [];
  const slots = (): SessionExtensionSlots => ({
    "botanical-skills": {
      status: "running",
      revision: "sha256:fixture",
      value: null,
      catalog: {
        protocol: "whistle.catalog/v1",
        commands: [
          {
            id: "skills",
            title: "Skills",
            category: "Conversation",
            projections: { slash: { aliases: ["skills"] } },
          },
        ],
      },
    },
  });
  const session: ParakeetSession = {
    ...fixture.session,
    read: async (input) => ({
      ...(await fixture.session.read(input)),
      extensions: slots(),
    }),
    watch: async (input) => {
      const watch = await fixture.session.watch(input);
      return { ...watch, snapshot: { ...watch.snapshot, extensions: slots() } };
    },
    extension: () => ({
      call: (name, args) => {
        calls.push([name, args]);
        return Promise.resolve(calls.length === 1 ? listing : details);
      },
    }),
  };
  const commands = createWhistle();
  const query = createQueryClient();
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame initialTheme="mocha" session={session} commands={commands} />
    </QueryClientProvider>,
    { width: 100, height: 30, kittyKeyboard: true },
  );
  const key = async (name: string) => {
    act(() => {
      setup.mockInput.pressKey(name);
    });
    await act(async () => setup.renderOnce());
  };
  const frame = async (text: string) =>
    act(async () => setup.waitForFrame((value) => value.includes(text)));
  try {
    await frame("Ask anything");
    await act(async () => setup.mockInput.typeText("/skills"));
    await key("RETURN");
    await frame("2 skills discovered");
    const shown = setup.captureCharFrame();
    // Each skill's name is followed by its SKILL.md, which names its folder.
    const order = [
      "botanical-retention",
      `${project}/botanical-retention/SKILL.md`,
      "herdr",
      `${personal}/herdr/SKILL.md`,
    ].map((text) => shown.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    await key("ARROW_DOWN");
    await key("RETURN");
    await frame("Coordinate teams");
    expect(calls).toEqual([
      ["skills", {}],
      ["skills", { name: "herdr" }],
    ]);
  } finally {
    await destroyTestRenderer(setup);
    query.clear();
    commands.close();
    await fixture.waitForClose();
    notifyManager.setScheduler(defaultScheduler);
  }
});
