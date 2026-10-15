import { expect, test } from "bun:test";
import { TextareaRenderable, type Renderable } from "@opentui/core";
import { testPaneRender } from "./pane-render.js";
import { act, useState } from "react";
import { TerminalComposer } from "../src/panes/conversation/terminal-composer.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

function findEditor(node: Renderable): TextareaRenderable | undefined {
  if (node instanceof TextareaRenderable) return node;
  for (const child of node.getChildren()) {
    const editor = findEditor(child);
    if (editor) return editor;
  }
  return undefined;
}

test("native composer preserves multiline paste, wraps and submits the edited draft", async () => {
  const submitted: string[] = [];
  function Composer() {
    const [value, setValue] = useState("");
    const { colors } = useTerminalTheme("mocha");
    return (
      <box flexDirection="row">
        <TerminalComposer
          value={value}
          onChange={setValue}
          onSubmit={() => {
            submitted.push(value);
            setValue("");
          }}
          focused
          maxHeight={4}
          colors={colors}
        />
      </box>
    );
  }
  const setup = await testPaneRender(<Composer />, {
    width: 32,
    height: 10,
    kittyKeyboard: true,
  });
  try {
    const pasted =
      "Read the current Session source\nand keep the actual admitted work visible.";
    await act(async () => setup.mockInput.pasteBracketedText(pasted));
    await act(async () => setup.renderOnce());
    const editor = findEditor(setup.renderer.root);
    expect(editor).toBeDefined();
    expect(editor?.plainText).toBe(pasted);
    expect(editor?.height).toBeGreaterThan(1);
    expect(editor?.height).toBeLessThanOrEqual(4);
    expect(submitted).toEqual([]);

    await act(async () => {
      setup.mockInput.pressEnter({ shift: true });
      await setup.renderOnce();
    });
    await act(async () => setup.mockInput.typeText("Then report."));
    await act(async () => {
      setup.mockInput.pressArrow("left");
      await setup.renderOnce();
    });
    await act(async () => setup.mockInput.typeText("!?"));
    expect(editor?.plainText).toBe(pasted + "\nThen report!?.");
    await act(async () => {
      setup.mockInput.pressKey("END");
      await setup.renderOnce();
    });
    await act(async () => {
      setup.mockInput.pressEnter({ meta: true });
      await setup.renderOnce();
    });
    await act(async () => setup.mockInput.typeText("After Alt+Enter."));
    const edited = pasted + "\nThen report!?.\nAfter Alt+Enter.";
    expect(editor?.plainText).toBe(edited);
    expect(submitted).toEqual([]);
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.renderOnce();
    });
    await act(async () => setup.renderOnce());
    expect(submitted).toEqual([edited]);
    expect(editor?.plainText).toBe("");
    expect(editor?.height).toBe(1);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("an idle composer accepts a long bracketed paste after native focus is lost", async () => {
  let draft = "";
  function Composer() {
    const [value, setValue] = useState("");
    const { colors } = useTerminalTheme("mocha");
    return (
      <TerminalComposer
        value={value}
        onChange={(next) => {
          draft = next;
          setValue(next);
        }}
        onSubmit={() => undefined}
        focused
        maxHeight={4}
        colors={colors}
      />
    );
  }
  const setup = await testPaneRender(<Composer />, { width: 64, height: 12 });
  try {
    const editor = findEditor(setup.renderer.root);
    expect(editor).toBeDefined();
    if (!editor) throw new Error("Composer missing");
    editor.blur();
    const pasted = `Check "/model" and (resume). ${"a (quoted) phrase ".repeat(42)}`;
    expect(pasted.length).toBeGreaterThan(700);
    await act(async () => setup.mockInput.pasteBracketedText(pasted));
    await act(async () => setup.renderOnce());
    expect(editor.plainText).toBe(pasted);
    expect(draft).toBe(pasted);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("an idle composer accepts a long text burst after native focus is lost", async () => {
  let draft = "";
  function Composer() {
    const [value, setValue] = useState("");
    const { colors } = useTerminalTheme("mocha");
    return (
      <TerminalComposer
        value={value}
        onChange={(next) => {
          draft = next;
          setValue(next);
        }}
        onSubmit={() => undefined}
        focused
        maxHeight={4}
        colors={colors}
      />
    );
  }
  const setup = await testPaneRender(<Composer />, { width: 64, height: 12 });
  try {
    const editor = findEditor(setup.renderer.root);
    expect(editor).toBeDefined();
    if (!editor) throw new Error("Composer missing");
    editor.blur();
    const pasted = `Check "/model" and (resume). ${"a (quoted) phrase ".repeat(42)}`;
    await act(async () => setup.mockInput.typeText(pasted));
    await act(async () => setup.renderOnce());
    expect(editor.plainText).toBe(pasted);
    expect(draft).toBe(pasted);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("composer leaves a bracketed paste to an open dialog", async () => {
  let draft = "";
  function Composer() {
    const [value, setValue] = useState("");
    const { colors } = useTerminalTheme("mocha");
    return (
      <TerminalComposer
        value={value}
        onChange={(next) => {
          draft = next;
          setValue(next);
        }}
        onSubmit={() => undefined}
        focused={false}
        maxHeight={4}
        colors={colors}
      />
    );
  }
  const setup = await testPaneRender(<Composer />, { width: 64, height: 12 });
  try {
    await act(async () =>
      setup.mockInput.pasteBracketedText("dialog response"),
    );
    await act(async () => setup.renderOnce());
    expect(draft).toBe("");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
