import assert from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const react = require("react");
const declared = require("../package.json").dependencies.react;

assert.equal(
  react.version,
  declared,
  "The deployed proof must resolve the React declared by the deployed package.",
);

for (const consumer of [
  "@opentui/react",
  "@tanstack/react-query",
  "@fungi.computer/parakeet",
  "@fungi.computer/spore/frame",
]) {
  const consumerRequire = createRequire(import.meta.resolve(consumer));
  assert.equal(
    consumerRequire("react"),
    react,
    `${consumer} and the deployed proof must share one React instance.`,
  );
}

process.stdout.write(
  `Deployed React ${react.version}: proof and renderers share one instance.\n`,
);
