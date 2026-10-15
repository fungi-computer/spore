import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { Picker, type PickerProps } from "../src/button/picker.js";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { InteractionView } from "../src/button/interaction-dialog.js";
import {
  createWhistleInteractionHost,
  type WhistleInteractionHost,
} from "@fungi.computer/whistle/interaction";

function DialogPicker(props: Omit<PickerProps, "colors">) {
  const { colors } = useTerminalTheme("mocha");
  return (
    <DialogSurface colors={colors} onClose={props.onCancel}>
      <Picker {...props} colors={colors} />
    </DialogSurface>
  );
}
function Failure({ host }: { host: WhistleInteractionHost }) {
  const { colors } = useTerminalTheme("mocha");
  return (
    <DialogSurface
      colors={colors}
      onClose={() => {
        host.cancel();
      }}
    >
      <InteractionView
        host={host}
        colors={colors}
        onRetry={() => undefined}
        onClose={() => {
          host.cancel();
        }}
      />
    </DialogSurface>
  );
}

for (const width of [80, 48]) {
  test(`every option label renders whole, including its cursor gutter, at ${String(width)} columns`, async () => {
    const labels = [
      "Try again",
      "Close",
      "Try again with a different account key",
    ];
    const selected: number[] = [];
    const setup = await testRender(
      <DialogPicker
        title="Choose"
        choices={labels.map((name) => ({ name }))}
        onSelect={(index) => selected.push(index)}
        onCancel={() => undefined}
      />,
      { width, height: 24 },
    );
    try {
      await act(async () => setup.renderOnce());
      for (let index = 0; index < labels.length; index += 1) {
        if (index > 0)
          act(() => {
            setup.mockInput.pressArrow("down");
          });
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        for (const label of labels) expect(frame).toContain(label);
        expect(frame).toContain(`▶ ${labels[index] ?? ""}`);
      }
      act(() => {
        setup.mockInput.pressEnter();
      });
      expect(selected).toEqual([2]);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });

  test(`login failure is borderless with blank lines around its choices at ${String(width)} columns`, async () => {
    const host = createWhistleInteractionHost({
      title: "Sign in to a model provider",
    });
    host
      .begin()
      .settle({ status: "failed", message: "The provider refused this key." });
    const setup = await testRender(<Failure host={host} />, {
      width,
      height: 24,
    });
    try {
      await act(async () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      expect(frame).not.toMatch(/[\u2500-\u257f]/u);
      const lines = frame.split("\n");
      const error = lines.findIndex((line) =>
        line.includes("provider refused"),
      );
      const retry = lines.findIndex((line) => line.includes("Try again"));
      const close = lines.findIndex((line) => line.includes("Close"));
      const hints = lines.findIndex((line) => line.includes("Enter select"));
      expect(retry).toBe(error + 2);
      expect(hints).toBe(close + 2);
      expect(lines[error + 1]?.trim()).toBe("");
      expect(lines[close + 1]?.trim()).toBe("");
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}

test("expand and filter reveal grouped choices and select their original answer", async () => {
  const selected: number[] = [];
  const setup = await testRender(
    <DialogPicker
      title="Provider"
      searchable
      collapsedGroups={["More providers"]}
      choices={[
        { name: "OpenAI", group: "Signed in" },
        { name: "DeepSeek", group: "More providers" },
        { name: "OpenRouter", group: "More providers" },
      ]}
      onSelect={(index) => selected.push(index)}
      onCancel={() => undefined}
    />,
    { width: 48, height: 24 },
  );
  try {
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("More providers (2)…");
    expect(setup.captureCharFrame()).not.toContain("DeepSeek");
    act(() => {
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(selected).toEqual([]);
    expect(setup.captureCharFrame()).toContain("MORE PROVIDERS");
    expect(setup.captureCharFrame()).toContain("▶ DeepSeek");
    await act(async () => setup.mockInput.typeText("router"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("▶ OpenRouter");
    expect(setup.captureCharFrame()).not.toContain("DeepSeek");
    act(() => {
      setup.mockInput.pressEnter();
    });
    expect(selected).toEqual([2]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("the command picker filters every collapsed group and keeps descriptions on one row", async () => {
  const selected: number[] = [];
  const setup = await testRender(
    <DialogPicker
      title="Commands"
      searchable
      descriptionWrap={false}
      collapsedGroups={["Panes", "Advanced"]}
      collapsedLabel="More commands"
      visibleLimit={1}
      choices={[
        {
          name: "Model",
          description:
            "Choose the current model. Null clears the Session override and returns to the configured default.",
          group: "Settings",
        },
        { name: "Split panes", description: "Side by side", group: "Panes" },
        { name: "Session status", group: "Advanced" },
      ]}
      onSelect={(index) => selected.push(index)}
      onCancel={() => undefined}
    />,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("More commands (2)…");
    expect(frame).not.toContain("Split panes");
    expect(frame).not.toContain("configured default.");
    expect(frame).not.toContain("Choose the current model");
    act(() => {
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("PANES");
    expect(setup.captureCharFrame()).toContain("ADVANCED");
    expect(setup.captureCharFrame()).toContain("▶ Split panes");
    await act(async () => setup.mockInput.typeText("status"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("▶ Session status");
    act(() => {
      setup.mockInput.pressEnter();
    });
    expect(selected).toEqual([2]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const width of [80, 160]) {
  test(`command descriptions share a left-aligned column and hide rather than truncate at ${String(width)} columns`, async () => {
    const setup = await testRender(
      <DialogPicker
        title="Commands"
        descriptionWrap={false}
        choices={[
          { name: "Model", description: "Choose a model" },
          { name: "Thinking level", description: "Choose thinking effort" },
          {
            name: "Long description",
            description:
              "This description cannot fit in the available column without truncating",
          },
        ]}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />,
      { width, height: width === 80 ? 24 : 48 },
    );
    try {
      await act(async () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      const lines = frame.split("\n");
      const model = lines.find((line) => line.includes("Choose a model"));
      const thinking = lines.find((line) =>
        line.includes("Choose thinking effort"),
      );
      expect(model).toBeDefined();
      expect(thinking).toBeDefined();
      expect(model?.indexOf("Choose a model")).toBe(
        thinking?.indexOf("Choose thinking effort"),
      );
      expect(frame).not.toContain("This description");
      expect(frame).not.toContain("…");
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}

for (const width of [80, 160]) {
  test(`the selected choice description uses readable selection colors at ${String(width)} columns`, async () => {
    const setup = await testRender(
      <DialogPicker
        title="Panes"
        choices={[{ name: "Open pane", description: "o" }]}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />,
      { width, height: width === 80 ? 24 : 48 },
    );
    try {
      await act(async () => setup.renderOnce());
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const label = spans.find((span) => span.text.includes("Open pane"));
      const key = spans.find((span) => span.text.trim() === "o");
      expect(label).toBeDefined();
      expect(key).toBeDefined();
      expect(key?.fg.toInts()).toEqual(label?.fg.toInts());
      expect((key?.attributes ?? 0) & 2).toBe(0);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}
