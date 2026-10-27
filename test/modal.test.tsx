import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  createWhistleInteractionHost,
  type WhistleInteractionHost,
} from "@fungi.computer/whistle/interaction";
import type { WhistlePrompt } from "@fungi.computer/whistle";
import {
  interactionTitleLimit,
  parsePrompt,
} from "@fungi.computer/whistle/wire";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

/** Set MODAL_RENDER_OUT to also save every render as a text file. */
const renderOut = process.env.MODAL_RENDER_OUT;

const objective =
  "Read the approval card review, audit every modal in apps/tui and write the plan with mock-ups for each one of them, then build the shared anatomy and migrate every producer to it.";

const goalPaused = (
  summary: string,
  facts: { label: string; value: string }[] = [],
): WhistlePrompt => ({
  type: "choice",
  message: "Goal paused: Finish the TUI modal redesign",
  summary,
  facts: [{ label: "Started", value: "14:02 today" }, ...facts],
  body: objective,
  bodyLabel: "Goal",
  details: [
    { label: "Goal", value: objective },
    { label: "Paused", value: "failed · Goal work failed" },
  ],
  options: [
    { value: "resume", label: "Resume goal" },
    { value: "replace", label: "Replace goal…" },
    { value: "clear-ask", label: "Clear goal…", destructive: true },
  ],
});

const clearConfirm: WhistlePrompt = {
  type: "confirmation",
  message: "Clear this goal?",
  summary: "It moves to history and can't be resumed.",
  confirmLabel: "Clear goal",
  cancelLabel: "Keep goal",
  destructive: true,
};

function Modal({ host }: Readonly<{ host: WhistleInteractionHost }>) {
  const { colors } = useTerminalTheme("mocha");
  return (
    <DialogSurface colors={colors} onClose={() => undefined}>
      <InteractionView host={host} colors={colors} onClose={() => undefined} />
    </DialogSurface>
  );
}

/** Open one prompt and return its answer, the renderer and a text capture. */
async function open(
  prompt: WhistlePrompt,
  size: { width: number; height: number } = { width: 80, height: 24 },
) {
  const host = createWhistleInteractionHost({ title: "Goal" });
  const answer = host.begin().interaction.prompt(prompt);
  const answered: unknown[] = [];
  void answer.then((value) => answered.push(value));
  const setup = await testRender(<Modal host={host} />, size);
  await act(async () => {
    await setup.renderOnce();
  });
  /** The frame without trailing blanks, one string per rendered line. */
  const text = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();
  const press = async (action: () => void) => {
    act(action);
    await act(async () => setup.renderOnce());
  };
  const type = (text: string) =>
    press(() => {
      void setup.mockInput.typeText(text);
    });
  const arrow = (direction: "up" | "down") =>
    press(() => {
      setup.mockInput.pressArrow(direction);
    });
  const enter = () =>
    press(() => {
      setup.mockInput.pressEnter();
    });
  const escape = () =>
    press(() => {
      setup.mockInput.pressEscape();
    });
  const save = async (name: string) => {
    if (renderOut === undefined) return;
    await mkdir(renderOut, { recursive: true });
    await writeFile(join(renderOut, `${name}.txt`), `${text()}\n`);
  };
  return {
    setup,
    answered,
    text,
    press,
    type,
    arrow,
    enter,
    escape,
    save,
    destroy: () => {
      act(() => {
        setup.renderer.destroy();
      });
    },
  };
}

const sizes = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
] as const;

for (const size of sizes) {
  const suffix = String(size.width);

  test(`Goal paused (failed) at ${suffix} columns`, async () => {
    const modal = await open(
      goalPaused("The last turn failed. Resume to try again."),
      size,
    );
    try {
      const frame = modal.text();
      expect(frame).toMatchSnapshot();
      expect(frame).toContain("Goal paused: Finish the TUI modal redesign");
      expect(frame).toContain("… d shows all");
      expect(frame).toContain("▶ Resume goal");
      expect(frame).toContain("Clear goal…");
      expect(frame).toContain("d details");
      await modal.save(`goal-paused-failed-${suffix}`);
    } finally {
      modal.destroy();
    }
  });

  test(`Goal paused (blocked, quoted reason) at ${suffix} columns`, async () => {
    const modal = await open(
      goalPaused("The Agent is stuck and needs you.", [
        { label: "Why", value: "“No access to the release repo”" },
      ]),
      size,
    );
    try {
      expect(modal.text()).toMatchSnapshot();
      await modal.save(`goal-paused-blocked-${suffix}`);
    } finally {
      modal.destroy();
    }
  });

  test(`Goal paused (stalled) at ${suffix} columns`, async () => {
    const modal = await open(
      goalPaused("No progress for 3 turns, so Fungi paused it."),
      size,
    );
    try {
      expect(modal.text()).toMatchSnapshot();
      await modal.save(`goal-paused-stalled-${suffix}`);
    } finally {
      modal.destroy();
    }
  });

  test(`Goal paused details view at ${suffix} columns`, async () => {
    const modal = await open(goalPaused("The last turn failed."), size);
    try {
      await modal.type("d");
      const frame = modal.text();
      expect(frame).toMatchSnapshot();
      expect(frame).toContain("Details");
      expect(frame).not.toContain("Resume goal");
      expect(frame).not.toContain("… d shows all");
      await modal.save(`goal-paused-details-${suffix}`);
    } finally {
      modal.destroy();
    }
  });

  test(`Clear goal confirm step at ${suffix} columns`, async () => {
    const modal = await open(clearConfirm, size);
    try {
      const frame = modal.text();
      expect(frame).toMatchSnapshot();
      expect(frame).toContain("▶ Keep goal");
      expect(frame).toContain("2   Clear goal");
      await modal.save(`goal-clear-confirm-${suffix}`);
    } finally {
      modal.destroy();
    }
  });
}

test("the d key shows details and d or Esc returns to the same highlight", async () => {
  const modal = await open(goalPaused("The last turn failed."));
  try {
    await modal.arrow("down");
    expect(modal.text()).toContain("▶ Replace goal…");
    await modal.type("d");
    expect(modal.text()).toContain("Details");
    await modal.type("d");
    expect(modal.text()).toContain("▶ Replace goal…");
    await modal.type("d");
    await modal.escape();
    // The terminal parser holds a lone Esc briefly before it is a key.
    await act(async () => {
      await Bun.sleep(100);
      await modal.setup.renderOnce();
    });
    await act(async () => modal.setup.renderOnce());
    // Esc inside details goes back; it does not answer or close the prompt.
    expect(modal.text()).toContain("▶ Replace goal…");
    expect(modal.answered).toEqual([]);
  } finally {
    modal.destroy();
  }
});

test("a long body shows three lines and says d shows all; the full text is in details", async () => {
  const body = Array.from(
    { length: 12 },
    (_, index) => `Line ${String(index + 1)} of a very long request`,
  ).join("\n");
  const modal = await open({
    type: "choice",
    message: "A long request",
    body,
    options: [{ value: "ok", label: "OK" }],
  });
  try {
    const frame = modal.text();
    expect(frame).toContain("Line 1 of");
    expect(frame).toContain("Line 3 of");
    expect(frame).not.toContain("Line 4 of");
    expect(frame).toContain("… d shows all");
    await modal.type("d");
    expect(modal.text()).toContain("Line 12 of");
  } finally {
    modal.destroy();
  }
});

test("the prompt contract rejects a title longer than 60 characters", () => {
  const prompt = {
    type: "choice",
    options: [{ value: "ok", label: "OK" }],
  } as const;
  expect(() =>
    parsePrompt({ ...prompt, message: "x".repeat(interactionTitleLimit) }),
  ).not.toThrow();
  expect(() =>
    parsePrompt({ ...prompt, message: "x".repeat(interactionTitleLimit + 1) }),
  ).toThrow();
});

test("Enter on the Goal paused menu resumes; Clear is never reached by one key", async () => {
  const modal = await open(goalPaused("The last turn failed."));
  try {
    await modal.enter();
    expect(modal.answered).toEqual(["resume"]);
  } finally {
    modal.destroy();
  }
});

test("choosing Clear only asks; it answers clear-ask, never clear", async () => {
  const modal = await open(goalPaused("The last turn failed."));
  try {
    await modal.type("3");
    expect(modal.answered).toEqual(["clear-ask"]);
  } finally {
    modal.destroy();
  }
});

test("Enter on a destructive confirmation keeps; Esc keeps; only 2 confirms", async () => {
  const enter = await open(clearConfirm);
  try {
    await enter.enter();
    expect(enter.answered).toEqual([false]);
  } finally {
    enter.destroy();
  }
  const keep = await open(clearConfirm);
  try {
    await keep.type("1");
    expect(keep.answered).toEqual([false]);
  } finally {
    keep.destroy();
  }
  const clear = await open(clearConfirm);
  try {
    await clear.type("2");
    expect(clear.answered).toEqual([true]);
  } finally {
    clear.destroy();
  }
});

test("a harmless confirmation focuses the action", async () => {
  const modal = await open({
    type: "confirmation",
    message: "Apply this model?",
    confirmLabel: "Apply",
    cancelLabel: "Keep current",
  });
  try {
    expect(modal.text()).toContain("▶ Apply");
    await modal.enter();
    expect(modal.answered).toEqual([true]);
  } finally {
    modal.destroy();
  }
});

test("a current choice is marked and focused first", async () => {
  const modal = await open({
    type: "choice",
    message: "Thinking level",
    current: "high",
    options: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
      { value: "max", label: "max" },
    ],
  });
  try {
    const frame = modal.text();
    expect(frame).toContain("▶ ● high");
    await modal.enter();
    expect(modal.answered).toEqual(["high"]);
  } finally {
    modal.destroy();
  }
});

test("the destructive option is drawn in the error tone, not the ordinary ink", async () => {
  const modal = await open(goalPaused("The last turn failed."));
  try {
    const spans = modal.setup
      .captureSpans()
      .lines.flatMap((line) => line.spans);
    const ink = (text: string) =>
      spans
        .find((span) => span.text.includes(text))
        ?.fg.toInts()
        .join(",");
    expect(ink("Clear goal…")).toBeDefined();
    expect(ink("Clear goal…")).not.toBe(ink("Replace goal…"));
  } finally {
    modal.destroy();
  }
});
