import { expect, test } from "bun:test";
import { act } from "react";
import { sigilGutterText } from "../src/button/index.js";
import {
  asks,
  mount,
  mountInApplication,
} from "./composer-question-fixture.js";

const idleStatus = `${sigilGutterText("●")}idle`;
const waitingStatus = `${sigilGutterText("●")}waiting on you`;

test("a question takes over an empty composer; Esc is Later, never an answer", async () => {
  const page = await mount(100, 30);
  try {
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    const taken = await page.frame("1. Blue (recommended)");
    expect(taken).toContain("Which color should we use?");
    expect(taken).toContain("4. Other…");
    expect(taken).toContain("Esc later");
    expect(taken).toContain(waitingStatus);
    expect(taken).not.toContain("Ask anything");
    await page.key("2");
    expect(page.question.answers()).toEqual([]);
    await page.key("ESCAPE");
    const parked = await page.frame("Alt+↑ answer");
    expect(parked).toContain("Ask anything");
    expect(parked).not.toContain("1. Blue");
    expect(page.question.answers()).toEqual([]);
    expect(page.fixture.cancelCalls()).toEqual([]);
    await page.key("ARROW_UP", { meta: true });
    await page.frame("1. Blue (recommended)");
    await page.key("2");
    await page.key("RETURN");
    await page.gone("1. Blue");
    expect(page.question.answers()).toEqual([{ selected: ["Green"] }]);
    const settled = await page.frame("Ask anything");
    expect(settled).toContain(idleStatus);
    expect(page.fixture.cancelCalls()).toEqual([]);
  } finally {
    await page.close();
  }
});

test("a question does not take over a non-empty draft", async () => {
  const page = await mount(100, 30);
  try {
    await page.type("Keep this draft");
    await page.frame("Keep this draft");
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    const waiting = await page.frame("Alt+↑ answer");
    expect(waiting).toContain("Keep this draft");
    expect(waiting).not.toContain("1. Blue");
    expect(waiting).toContain(waitingStatus);
    await page.type("!");
    await page.frame("Keep this draft!");
    expect(page.question.answers()).toEqual([]);
  } finally {
    await page.close();
  }
});

test("draft returns after Esc", async () => {
  const page = await mount(100, 30);
  try {
    await page.type("Keep this draft");
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    await page.frame("Alt+↑ answer");
    await page.key("ARROW_UP", { meta: true });
    await page.frame("1. Blue (recommended)");
    await page.key("ESCAPE");
    const back = await page.gone("1. Blue");
    expect(back).toContain("Keep this draft");
    expect(back).toContain("Alt+↑ answer");
    await page.type("?");
    await page.frame("Keep this draft?");
    expect(page.question.answers()).toEqual([]);
    expect(page.fixture.cancelCalls()).toEqual([]);
  } finally {
    await page.close();
  }
});

test("typing jumps to the Other line, Esc steps back keeping the text, Enter sends it", async () => {
  const page = await mount(100, 30);
  try {
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    await page.frame("1. Blue (recommended)");
    await page.type("Mauve");
    const typed = await page.frame("Mauve");
    expect(typed).toContain("Enter send · Esc back");
    await page.key("ESCAPE");
    const back = await page.frame("Esc later");
    expect(back).toContain("Mauve");
    expect(page.question.answers()).toEqual([]);
    await page.key("4");
    await page.frame("Esc back");
    await page.key("RETURN");
    await page.gone("1. Blue");
    expect(page.question.answers()).toEqual([{ selected: [], text: "Mauve" }]);
  } finally {
    await page.close();
  }
});

test("a multiple question toggles with Space and needs one pick", async () => {
  const page = await mount(100, 30);
  try {
    const ship = asks[2];
    if (ship === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, ship));
    const open = await page.frame("[ ] Blue");
    expect(open).toContain("Space toggle");
    await page.key("RETURN");
    expect(page.question.answers()).toEqual([]);
    await page.key(" ");
    await page.key("ARROW_DOWN");
    await page.key("ARROW_DOWN");
    await page.key(" ");
    await page.frame("[x] Teal");
    await page.key("RETURN");
    await page.gone("[x] Blue");
    expect(page.question.answers()).toEqual([{ selected: ["Blue", "Teal"] }]);
  } finally {
    await page.close();
  }
});

test("the marker counts every waiting decision and Later keeps them all", async () => {
  const page = await mount(100, 30);
  try {
    await act(page.question.ask.bind(null, ...asks.slice(0, 2)));
    const first = await page.frame("1 of 2");
    expect(first).toContain("Which color should we use?");
    await page.key("ESCAPE");
    const second = await page.frame("2 of 2");
    expect(second).toContain("Where should the notes live?");
    expect(second).toContain(
      "Which color should we use? · 1 of 2 · Alt+↑ answer",
    );
    expect(page.question.answers()).toEqual([]);
  } finally {
    await page.close();
  }
});

test("Esc reaches the question through the terminal's own keymap: back once, then Later", async () => {
  const page = await mountInApplication();
  try {
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    await page.frame("1. Blue (recommended)");
    await page.key("4");
    await page.frame("Esc back");
    await page.key("ESCAPE");
    await page.frame("Esc later");
    await page.key("ESCAPE");
    await page.frame("Alt+↑ answer");
    expect(page.question.answers()).toEqual([]);
    expect(page.fixture.cancelCalls()).toEqual([]);
  } finally {
    await page.close();
  }
});

test("waiting on you appears only for escalated items", async () => {
  const page = await mount(100, 30);
  try {
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(
      page.question.ask.bind(null, {
        ...color,
        waitingOn: {
          agentId: "agent-shiitake",
          sessionId: "session-shiitake",
          name: "Shiitake",
        },
      }),
    );
    // Waiting on the Agent that sent the work: calm, and the composer stays the person's.
    const routed = await page.frame("waiting on Shiitake");
    expect(routed).toContain("Ask anything");
    expect(routed).not.toContain("1. Blue");
    expect(routed).not.toContain(waitingStatus);
    expect(page.question.calls).toEqual([]);
    // Escalated, the same question needs the person and takes over the composer.
    await act(page.question.ask.bind(null, color));
    const escalated = await page.frame("1. Blue (recommended)");
    expect(escalated).toContain(waitingStatus);
    expect(escalated).not.toContain("waiting on Shiitake");
  } finally {
    await page.close();
  }
});
