import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "bun:test";

test("direct TUI and Parakeet hooks resolve one React 19 peer", async () => {
  const fromTui = createRequire(import.meta.url);
  const parakeetHeadless = import.meta
    .resolve("@fungi.computer/parakeet/headless");
  const fromParakeet = createRequire(parakeetHeadless);
  const [tuiReact, parakeetReact] = await Promise.all([
    realpath(fromTui.resolve("react")),
    realpath(fromParakeet.resolve("react")),
  ]);

  assert.equal(parakeetReact, tuiReact);
  assert.match(tuiReact, /react@19\.2\.0/u);
});
