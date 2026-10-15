import { expect, test } from "bun:test";
import { createToolSigilProbe } from "../src/tool-sigil-probe.js";

const graphics = "\u001b_Gi=31337;OK\u001b\\";
const attributes = "\u001b[?62;22c";

test("enables graphics only when the native query succeeds before DA1", async () => {
  const probe = createToolSigilProbe();
  expect(probe.observe(graphics)).toBe(false);
  probe.observe(attributes);
  expect(await probe.result).toBe(true);
  probe.close();
});

test("DA1 first closes admission, including a later graphics reply", async () => {
  const probe = createToolSigilProbe();
  probe.observe(attributes);
  probe.observe(graphics);
  expect(await probe.result).toBe(false);
  probe.close();
});

test("a failed or unrelated graphics query does not enable sigils", async () => {
  const probe = createToolSigilProbe();
  probe.observe("\u001b_Gi=31;OK\u001b\\");
  probe.observe("\u001b_Gi=31337;ENOTSUP\u001b\\");
  probe.observe(attributes);
  expect(await probe.result).toBe(false);
  probe.close();
});

test("probe timeout and close keep the text fallback", async () => {
  const timedOut = createToolSigilProbe(0);
  expect(await timedOut.result).toBe(false);
  timedOut.observe(graphics);
  expect(await timedOut.result).toBe(false);
  const closed = createToolSigilProbe();
  closed.close();
  expect(await closed.result).toBe(false);
});

test("a non-zero probe deadline closes admission without a late reply", async () => {
  const probe = createToolSigilProbe(20);
  expect(await probe.result).toBe(false);
  probe.observe(graphics);
  expect(await probe.result).toBe(false);
});
