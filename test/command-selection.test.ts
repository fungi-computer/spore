import { expect, test } from "bun:test";
import { createWhistle } from "@fungi.computer/whistle";
import {
  observeCommandExecutions,
  waitForCommandGraph,
} from "./command-selection.js";

test("a command notice does not complete observation while its handler is pending", async () => {
  const { commands, nextExecution } = observeCommandExecutions(createWhistle());
  const notified = Promise.withResolvers<undefined>();
  const saved = Promise.withResolvers<undefined>();
  commands.contribute({
    sourceId: "save-fixture",
    namespace: "fixture",
    commands: [
      {
        id: "save",
        title: "Save",
        category: "Fixture",
        projections: { slash: { aliases: ["save"] } },
        handler: async () => {
          notified.resolve(undefined);
          await saved.promise;
          return "saved";
        },
      },
    ],
  });
  try {
    let completed = false;
    const observed = nextExecution("save").then((outcome) => {
      completed = true;
      return outcome;
    });
    const executing = commands.execute(
      { namespace: "fixture", id: "save" },
      { origin: "slash" },
    );
    await notified.promise;
    expect(completed).toBe(false);
    saved.resolve(undefined);
    expect(await observed).toEqual({ status: "handled", result: "saved" });
    expect(await executing).toEqual({ status: "handled", result: "saved" });
  } finally {
    saved.resolve(undefined);
    commands.close();
  }
});

test("command graph readiness observes admission and handles an already-ready graph", async () => {
  const commands = createWhistle();
  try {
    const ready = () =>
      commands.snapshot().slash.some((row) => row.alias === "save");
    let admitted = false;
    const admission = waitForCommandGraph(commands, ready).then(() => {
      admitted = true;
    });
    expect(admitted).toBe(false);
    commands.contribute({
      sourceId: "save-fixture",
      namespace: "fixture",
      commands: [
        {
          id: "save",
          title: "Save",
          category: "Fixture",
          projections: { slash: { aliases: ["save"] } },
          handler: () => undefined,
        },
      ],
    });
    await admission;
    expect(admitted).toBe(true);
    await waitForCommandGraph(commands, ready);
  } finally {
    commands.close();
  }
});
