import { expect, test } from "bun:test";
import { nextTerminalEscape } from "../src/panes/conversation/terminal-escape.js";

const idle = {
  interaction: null,
  queued: false,
  status: "idle",
  cancellationPending: false,
  waitingLabel: undefined,
} satisfies Parameters<typeof nextTerminalEscape>[0];

test("Esc stops only running work regardless of queued prompts", () => {
  for (const queued of [false, true]) {
    expect(nextTerminalEscape({ ...idle, queued, status: "thinking" })).toEqual(
      { kind: "active" },
    );
    expect(
      nextTerminalEscape({ ...idle, queued, status: "cancelling" }),
    ).toEqual({ kind: "none" });
    expect(
      nextTerminalEscape({
        ...idle,
        queued,
        status: "thinking",
        cancellationPending: true,
      }),
    ).toEqual({ kind: "none" });
  }
  expect(
    nextTerminalEscape({ ...idle, queued: true, status: "queued" }),
  ).toEqual({ kind: "none" });
  expect(nextTerminalEscape({ ...idle, waitingLabel: "stop loop" })).toEqual({
    kind: "none",
  });
});

test("interactions dismiss first and ordinary notices follow running work", () => {
  expect(
    nextTerminalEscape({ ...idle, status: "thinking", interaction: "prompt" }),
  ).toEqual({ kind: "interaction" });
  expect(nextTerminalEscape({ ...idle, interaction: "actions" })).toEqual({
    kind: "interaction",
  });
  expect(nextTerminalEscape({ ...idle, notice: true })).toEqual({
    kind: "notice",
  });
  expect(
    nextTerminalEscape({ ...idle, status: "thinking", notice: true }).kind,
  ).toBe("active");
});
