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
    // The card sits above the composer: the composer stays visible.
    expect(taken).toContain("Ask anything");
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

test("a question sits above a non-empty draft without taking the keys from it", async () => {
  const page = await mount(100, 30);
  try {
    await page.type("Keep this draft");
    await page.frame("Keep this draft");
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    // The card shows above the draft, which was being typed, so it keeps the keys.
    const waiting = await page.frame("1. Blue (recommended)");
    expect(waiting).toContain("Keep this draft");
    expect(waiting).toContain(waitingStatus);
    // The draft has the keys, so the card says which key gives them back.
    expect(waiting).toContain("Shift+Tab answer");
    expect(waiting).not.toContain("Enter choose");
    await page.type("!");
    await page.frame("Keep this draft!");
    expect(page.question.answers()).toEqual([]);
    // Shift+Tab hands the keys to the card; Tab hands them back to the composer.
    await page.key("TAB", { shift: true });
    await page.key("ARROW_DOWN");
    await page.key("RETURN");
    await page.gone("1. Blue");
    expect(page.question.answers()).toEqual([{ selected: ["Blue"] }]);
    // The draft was never touched.
    expect(page.fixture.cancelCalls()).toEqual([]);
  } finally {
    await page.close();
  }
});

test("Alt+Up gives a card the keys back even with a draft, and Later keeps the draft", async () => {
  const page = await mount(100, 30);
  try {
    await page.type("Keep this draft");
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    await page.frame("Shift+Tab answer");
    // Hand the keys to the card, then postpone it with Esc.
    await page.key("TAB", { shift: true });
    await page.frame("Enter choose");
    await page.key("ESCAPE");
    const parked = await page.gone("1. Blue");
    expect(parked).toContain("Keep this draft");
    expect(parked).toContain("Alt+↑ answer");
    // Asking to answer returns the card with the keys, whatever the draft holds.
    await page.key("ARROW_UP", { meta: true });
    await page.frame("1. Blue (recommended)");
    await page.type("2");
    await page.key("RETURN");
    await page.gone("1. Blue");
    expect(page.question.answers()).toEqual([{ selected: ["Green"] }]);
    const after = await page.frame("Keep this draft");
    expect(after).not.toContain("Keep this draft2");
    expect(page.fixture.cancelCalls()).toEqual([]);
  } finally {
    await page.close();
  }
});

test("slash completion shows beside a pending card once the composer has the keys", async () => {
  const page = await mount(100, 30);
  try {
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    await page.frame("1. Blue (recommended)");
    await page.key("TAB");
    await page.type("/");
    const completion = await page.frame("/help");
    // The list is drawn beside the card, so Tab and the arrows act on what shows.
    expect(completion).toContain("1. Blue (recommended)");
    expect(page.question.answers()).toEqual([]);
  } finally {
    await page.close();
  }
});

test("Tab moves between the card and the composer, which stays usable beside a pending card", async () => {
  const page = await mount(100, 30);
  try {
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    const card = await page.frame("Tab message");
    expect(card).toContain("1. Blue (recommended)");
    expect(card).toContain("Ask anything");
    await page.key("TAB");
    await page.type("hello");
    const typing = await page.frame("hello");
    // The card is still there and nothing was answered.
    expect(typing).toContain("1. Blue (recommended)");
    expect(page.question.answers()).toEqual([]);
    await page.key("TAB", { shift: true });
    await page.key("ARROW_DOWN");
    await page.key("RETURN");
    await page.gone("1. Blue");
    expect(page.question.answers()).toEqual([{ selected: ["Blue"] }]);
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
    // Nothing is preselected: the first arrow lands on the first row.
    await page.key("ARROW_DOWN");
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

test("j and k move like the arrows, Space picks, and any other letter starts the answer", async () => {
  const page = await mount(100, 30);
  try {
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(page.question.ask.bind(null, color));
    await page.frame("1. Blue (recommended)");
    // Nothing is picked before a move, so Space sends nothing.
    await page.key(" ");
    expect(page.question.answers()).toEqual([]);
    await page.key("j");
    await page.key("j");
    await page.key("k");
    await page.key("j");
    await page.key(" ");
    await page.gone("1. Blue");
    expect(page.question.answers()).toEqual([{ selected: ["Green"] }]);
  } finally {
    await page.close();
  }
  const second = await mount(100, 30);
  try {
    const [color] = asks;
    if (color === undefined) throw new Error("Missing fixture");
    await act(second.question.ask.bind(null, color));
    await second.frame("1. Blue (recommended)");
    // A letter other than j and k starts the type-it answer with that letter.
    await second.type("x");
    const typed = await second.frame("Enter send · Esc back");
    expect(typed).toContain("x");
    expect(second.question.answers()).toEqual([]);
  } finally {
    await second.close();
  }
});
