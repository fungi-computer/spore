import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { act } from "react";
import { TextareaRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";

function editorIn(node: Renderable): TextareaRenderable | undefined {
  if (node instanceof TextareaRenderable) return node;
  for (const child of node.getChildren()) {
    const editor = editorIn(child);
    if (editor) return editor;
  }
  return undefined;
}

assert.equal(process.stdout.isTTY, true, "Run this proof in a PTY");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const phase = process.argv[2];
assert.ok(phase === "before" || phase === "after");
const output = process.argv[3];
assert.ok(output, "Supply the evidence output directory as the third argument");
await mkdir(output, { recursive: true });
const timings: number[] = [];
for (let sample = 1; sample <= 5; sample += 1) {
  const fixture = createTuiFixture({
    beforePrompt: () => new Promise((resolve) => setTimeout(resolve, 150)),
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
    { width: 100, height: 30, kittyKeyboard: true },
  );
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("Ask anything")),
    );
    await act(async () =>
      setup.mockInput.typeText(`Sample ${String(sample)}: optimistic delivery`),
    );
    await act(async () => setup.renderOnce());
    await writeFile(
      `${output}/${phase}-${String(sample)}-typed.txt`,
      setup.captureCharFrame(),
    );
    const editor = editorIn(setup.renderer.root);
    assert.ok(editor);
    const started = performance.now();
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.renderOnce();
    });
    await act(async () => setup.renderOnce());
    const enterFrame = setup.captureCharFrame();
    for (let tick = 0; editor.plainText !== "" && tick < 1000; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await setup.renderOnce();
      });
    }
    assert.equal(editor.plainText, "", "Composer did not clear");
    timings.push(performance.now() - started);
    await writeFile(
      `${output}/${phase}-${String(sample)}-enter.txt`,
      enterFrame,
    );
    await act(async () => setup.renderOnce());
    await writeFile(
      `${output}/${phase}-${String(sample)}-cleared.txt`,
      setup.captureCharFrame(),
    );
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    commands.close();
    query.clear();
    await fixture.waitForClose();
  }
}
await writeFile(
  `${output}/${phase}-timings.json`,
  JSON.stringify(
    {
      phase,
      clock:
        "performance.now; keypress through first observed clear in native frame harness inside real PTY",
      serviceDelayMs: 150,
      samplesMs: timings,
    },
    null,
    2,
  ) + "\n",
);
