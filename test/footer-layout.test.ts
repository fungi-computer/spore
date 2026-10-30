import { expect, test } from "bun:test";
import { stringWidth } from "bun";
import { footerLayout } from "../src/button/footer-layout.js";
import { sessionStateLabel } from "../src/panes/conversation/session-state-label.js";
import type { ParakeetSessionViewState } from "@fungi.computer/parakeet/headless";

const model = "openai/gpt-6-sol";
const states: readonly ParakeetSessionViewState[] = [
  { kind: "idle" },
  { kind: "responding" },
  { kind: "queued", queuedCommandId: "other-conversation", runningWork: null },
  { kind: "running_tool", tool: "Local_Computer.exec" },
  { kind: "waiting_for_you" },
  {
    kind: "retrying",
    attempt: 2,
    maxAttempts: 4,
    cause: "503 Service Unavailable",
    nextRetryAt: 1000,
  },
  { kind: "error", cause: "The model provider refused the request" },
  { kind: "disconnected", cause: "The Session stream closed" },
];

for (const width of [60, 80, 100, 140]) {
  for (const state of states.slice(0, 2)) {
    test(`complete footer at ${String(width)} columns, ${state.kind}`, () => {
      const result = footerLayout({
        width: width - 2,
        status: `● ${sessionStateLabel(state)}`,
        compactStatus: `● ${sessionStateLabel(state)}`,
        model,
      });
      expect(result.statusText).toBe(
        state.kind === "responding" ? "● streaming" : "● idle",
      );
      expect(result.modelText).toBe(model);
      expect(result.modelText.endsWith(" ·")).toBe(false);
      expect(
        stringWidth(
          [result.statusText, result.modelText].filter(Boolean).join(" "),
        ),
      ).toBeLessThanOrEqual(width - 2);
    });
  }
}

test("keeps the complete provider/model identity or omits it when space runs out", () => {
  const input = { status: "● idle", compactStatus: "● idle", model };
  expect(footerLayout({ ...input, width: 48 }).modelText).toBe(model);
  expect(footerLayout({ ...input, width: 25 }).modelText).toBe(model);
  expect(footerLayout({ ...input, width: 19 }).modelText).toBe("");
  expect(
    footerLayout({
      ...input,
      status: "● running Local_Computer.exec",
      compactStatus: "● running",
      width: 25,
    }),
  ).toMatchObject({ statusText: "running", modelText: model });
});

test("all widths from 30–160 retain whole state without clipping provider/model ids", () => {
  for (let width = 30; width <= 160; width++) {
    for (const state of states) {
      const result = footerLayout({
        width: width - 2,
        status: `● ${sessionStateLabel(state)}`,
        compactStatus: `● ${sessionStateLabel(state)}`,
        model,
      });
      expect([model, ""]).toContain(result.modelText);
      if (width >= 40) expect(result.modelText).toBe(model);
      expect([
        `● ${sessionStateLabel(state)}`,
        sessionStateLabel(state),
      ]).toContain(result.statusText);
      expect(
        stringWidth(
          [result.statusText, result.modelText].filter(Boolean).join(" "),
        ),
      ).toBeLessThanOrEqual(width - 2);
    }
  }
});

test("counts terminal cells and keeps detailed status without a model", () => {
  expect(
    footerLayout({
      width: 40,
      status: "● running read",
      compactStatus: "● running",
    }).statusText,
  ).toBe("● running read");
  const result = footerLayout({
    width: 30,
    status: "● idle",
    compactStatus: "● idle",
    model: "本地/模型-6",
  });
  expect(result.modelWidth).toBe(stringWidth(result.modelText));
  expect(result.modelWidth + result.statusWidth + 1).toBeLessThanOrEqual(30);
});

test("at 30 columns the streaming word and model identity fit together", () => {
  const result = footerLayout({
    width: 28,
    status: "● streaming",
    compactStatus: "● streaming",
    model,
  });
  expect(result.statusText).toBe("● streaming");
  expect(result.modelText).toBe(model);
});

test("context use follows the model only when both fit whole", () => {
  const input = {
    status: "idle",
    compactStatus: "idle",
    model,
    context: "12K/200K",
  };
  expect(footerLayout({ ...input, width: 48 }).modelText).toBe(
    `${model} · 12K/200K`,
  );
  // Too narrow for both: the model identity keeps its place.
  expect(footerLayout({ ...input, width: 25 }).modelText).toBe(model);
  expect(footerLayout({ ...input, width: 48, model: "" })).toMatchObject({
    modelText: "",
  });
});
