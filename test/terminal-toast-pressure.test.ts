import { expect, test } from "bun:test";
import { createToastStore } from "../src/button/toast-store.js";
import { terminalControls } from "../src/panes/terminal/controls.js";

test("repeated refused PTY input and resize preserve one attention item per producer", () => {
  const store = createToastStore();
  const refused = {
    live: true,
    input: () => false,
    resize: () => false,
  };
  const controls = terminalControls(refused, store.show);
  try {
    store.show({ variant: "info", message: "visible" });
    for (let index = 0; index < 60; index += 1) {
      controls.input(new TextEncoder().encode("oversized paste"));
      controls.resize(80 + index, 24);
    }
    expect(store.snapshot().pending).toBe(2);
    store.dismiss();
    expect(store.snapshot().current?.message).toBe(
      "Local terminal input was not sent; retry with a smaller paste",
    );
    expect(store.snapshot().current?.duration).toBe("until-dismissed");
    const id = store.snapshot().current?.id;
    controls.input(new TextEncoder().encode("another paste"));
    expect(store.snapshot().current?.id).toBe(id);
    expect(store.snapshot().pending).toBe(1);
    store.dismiss();
    expect(store.snapshot().current?.message).toBe(
      "Local terminal resize was not sent",
    );
    controls.input(new TextEncoder().encode("after acknowledgement"));
    expect(store.snapshot().pending).toBe(1);
  } finally {
    store.dispose();
  }
});
