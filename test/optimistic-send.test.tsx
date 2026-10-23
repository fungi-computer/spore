import { expect, test } from "bun:test";
import { act } from "react";
import { TextareaRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";
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

for (const refused of [false, true]) {
  test(`Enter consumes the draft immediately; ${refused ? "refusal restores both drafts and toasts the reason" : "acceptance reconciles one row"}`, async () => {
    let accept: (() => void) | undefined;
    let reject: ((reason: Error) => void) | undefined;
    const fixture = createTuiFixture({
      beforePrompt: () =>
        new Promise<void>((resolve, refuse) => {
          accept = resolve;
          reject = refuse;
        }),
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
      const original = "  Exact first line\nand second line  ";
      await act(async () => setup.mockInput.pasteBracketedText(original));
      await act(async () => {
        setup.mockInput.pressEnter();
        await Promise.resolve();
      });
      const editor = editorIn(setup.renderer.root);
      if (!editor) throw new Error("Composer unavailable");
      expect(editor.plainText).toBe("");
      await act(async () => setup.renderOnce());
      const pending = setup.captureCharFrame();
      expect(pending).toContain("Exact first line");
      expect(pending).toContain("Ask anything");
      await act(async () => setup.mockInput.typeText("New draft"));
      if (accept === undefined || reject === undefined)
        throw new Error("Prompt not dispatched");
      if (refused) {
        await act(async () => {
          reject?.(new Error("Not enough credit"));
          await Promise.resolve();
        });
        await act(async () => setup.renderOnce());
        expect(editor.plainText).toBe(`New draft\n\n${original}`);
        expect(setup.captureCharFrame()).toContain("Not enough credit");
        await act(async () => setup.mockInput.typeText("!"));
        expect(editor.plainText).toBe(`New draft\n\n${original}!`);
      } else {
        await act(async () => {
          accept?.();
          await Promise.resolve();
        });
        await act(async () => {
          fixture.confirmLatestPrompt();
          await Promise.resolve();
        });
        await act(async () => setup.renderOnce());
        expect(editor.plainText).toBe("New draft");
        expect(
          setup.captureCharFrame().match(/Exact first line/g),
        ).toHaveLength(1);
      }
    } finally {
      await destroyTestRenderer(setup);
      commands.close();
      query.clear();
      await fixture.waitForClose();
    }
  });
}
