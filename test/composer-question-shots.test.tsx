import { test } from "bun:test";
import { act } from "react";
import process from "node:process";
import { asks, mount, transcript } from "./composer-question-fixture.js";

const output = process.env.TUI_COMPOSER_Q_SHOTS;

// Screenshot capture for review; it asserts nothing the product tests do not.
for (const theme of ["latte", "mocha"] as const)
  for (const [width, height] of [
    [120, 36],
    [60, 24],
  ] as const)
    test.skipIf(output === undefined)(
      `captures the composer question states at ${String(width)}x${String(height)} in ${theme}`,
      async () => {
        const page = await mount(width, height, theme, transcript);
        const name = (state: string) =>
          `after-${String(width)}-${theme}-${state}`;
        try {
          const [color, storage, ship] = asks;
          if (
            color === undefined ||
            storage === undefined ||
            ship === undefined
          )
            throw new Error("Missing fixtures");
          await act(page.question.ask.bind(null, color));
          await page.frame("Blue (recommended)");
          await page.shot(name("single"));
          await page.key("ARROW_DOWN");
          await page.shot(name("single-second"));
          await page.type("Mauve");
          await page.frame("Mauve");
          await page.shot(name("other"));
          await page.key("RETURN");
          await page.gone("Blue (recommended)");
          await act(page.question.ask.bind(null, ship));
          await page.frame("[ ] Blue");
          await page.key(" ");
          await page.key("ARROW_DOWN");
          await page.key("ARROW_DOWN");
          await page.key(" ");
          await page.shot(name("multiple"));
          await page.key("ESCAPE");
          await act(page.question.ask.bind(null, ship, color, storage));
          await page.frame("of 3");
          await page.shot(name("queue-2of3"));
          await page.key("ESCAPE");
          await page.frame("Alt+↑ answer");
          await page.shot(name("parked-row"));
          await page.key("ARROW_UP", { meta: true });
          await page.frame("Esc later");
          page.question.failAnswers(true);
          await page.key(" ");
          await page.key("RETURN");
          await page.frame("did not answer");
          await page.shot(name("refused"));
        } finally {
          await page.close();
        }
      },
    );
