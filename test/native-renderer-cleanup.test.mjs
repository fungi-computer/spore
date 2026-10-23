import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createElement, useEffect } from "react";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";

test("keeps act diagnostics enabled until unmount effects settle", async () => {
  const environments = [];
  const order = [];
  function Lifecycle() {
    useEffect(() => {
      return () => {
        globalThis.queueMicrotask(() => {
          order.push("unmount");
          environments.push(globalThis.IS_REACT_ACT_ENVIRONMENT);
        });
      };
    }, []);
    return null;
  }

  const setup = await testRender(createElement(Lifecycle), {
    width: 48,
    height: 10,
  });
  await destroyTestRenderer(setup, () => {
    order.push("bindings");
  });

  expect(environments).toEqual([true]);
  expect(order).toEqual(["bindings", "unmount"]);
  expect(globalThis.IS_REACT_ACT_ENVIRONMENT).toBe(false);
});
