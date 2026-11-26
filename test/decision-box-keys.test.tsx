import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { awaitingFixtures } from "@fungi.computer/parakeet-testing";
import { decisionView } from "@fungi.computer/parakeet/headless";
import { DecisionBox } from "../src/button/decision-box.js";
import {
  decisionKeys,
  type DecisionKeys,
} from "../src/button/decision-keys.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";

const found =
  awaitingFixtures.find((candidate) => candidate.kind === "question") ??
  awaitingFixtures[0];
if (found === undefined) throw new Error("No awaiting fixture");
const fixture: (typeof awaitingFixtures)[number] = found;

function Box(keys: DecisionKeys) {
  const { colors } = useTerminalTheme("mocha");
  return (
    <DecisionBox
      view={decisionView(fixture.state, fixture.prompt, {
        kind: fixture.kind,
        position: fixture.position,
        total: fixture.total,
      })}
      dispatch={() => undefined}
      onLeave={() => undefined}
      colors={colors}
      surface={colors.surface}
      width={100}
      rows={36}
      {...keys}
    />
  );
}

/** The card as the terminal draws it: its text, and the background behind its highlighted row. */
async function drawn(keys: DecisionKeys) {
  const setup = await testRender(<Box {...keys} />, { width: 100, height: 36 });
  try {
    await act(async () => setup.renderOnce());
    const text = setup.captureCharFrame();
    const marker = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("›"));
    return { text, highlight: marker?.bg.toInts().join(",") };
  } finally {
    await destroyTestRenderer(setup);
  }
}

const live = decisionKeys({
  focused: true,
  dialogOpen: false,
  cardHasKeys: true,
});
const composer = decisionKeys({
  focused: true,
  dialogOpen: false,
  cardHasKeys: false,
});

test("decisionKeys: every combination of focus, dialog and key owner", () => {
  for (const focused of [true, false])
    for (const dialogOpen of [true, false])
      for (const cardHasKeys of [true, false]) {
        const paused = !focused || dialogOpen;
        expect(decisionKeys({ focused, dialogOpen, cardHasKeys })).toEqual({
          hasKeys: cardHasKeys,
          paused,
          // A press lands on the card only while it holds the keys and nothing is paused.
          active: !paused && cardHasKeys,
        });
      }
});

test("a card that holds the keys and can take them names Tab to the message, never Shift+Tab", async () => {
  const { text } = await drawn(live);
  expect(text).toContain("Tab");
  expect(text).not.toContain("Shift+Tab");
});

test("a card the composer holds names Shift+Tab to answer", async () => {
  const { text } = await drawn(composer);
  expect(text).toContain("Shift+Tab");
  expect(text).toContain("answer");
});

for (const [name, facts] of [
  ["a dialog is open", { focused: true, dialogOpen: true }],
  ["the pane is unfocused", { focused: false, dialogOpen: false }],
] as const)
  for (const cardHasKeys of [true, false])
    test(`while ${name} and ${cardHasKeys ? "the card" : "the composer"} holds the keys, the card names no key`, async () => {
      const { text } = await drawn(decisionKeys({ ...facts, cardHasKeys }));
      expect(text).not.toContain("Shift+Tab");
      expect(text).not.toMatch(/Tab\s+message/u);
      expect(text).not.toContain("answer");
    });

test("the highlight is muted only while the composer holds the keys, not while a dialog or lost focus pauses the card", async () => {
  const lit = await drawn(live);
  const paused = await drawn(
    decisionKeys({ focused: true, dialogOpen: true, cardHasKeys: true }),
  );
  const handedOff = await drawn(composer);
  expect(paused.highlight).toBe(lit.highlight);
  expect(handedOff.highlight).not.toBe(lit.highlight);
});
