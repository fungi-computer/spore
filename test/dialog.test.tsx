import { expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { DialogHost, useDialog } from "../src/button/dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

function Harness({
  ready,
}: Readonly<{
  ready: (dialog: ReturnType<typeof useDialog>, select: () => void) => void;
}>) {
  const [lifetime, setLifetime] = useState("session-one");
  const dialog = useDialog(lifetime);
  const { colors } = useTerminalTheme("terminal");
  useEffect(() => {
    ready(dialog, () => {
      setLifetime("session-two");
    });
  }, [dialog, ready]);
  return (
    <box>
      <text>Chat ready</text>
      <input id="composer" focused={!dialog.isOpen} />
      <DialogHost dialog={dialog} colors={colors} />
    </box>
  );
}

test("replacing a dialog retains modal focus and ignores an old async close", async () => {
  let dialog: ReturnType<typeof useDialog> | undefined;
  const setup = await testRender(
    <Harness
      ready={(value) => {
        dialog = value;
      }}
    />,
    { width: 72, height: 20, useKittyKeyboard: null },
  );
  const pending = Promise.withResolvers<undefined>();
  let completed: Promise<void> | undefined;
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("Chat ready")),
    );
    const composer = setup.renderer.currentFocusedRenderable;
    expect(composer).toBeInstanceOf(InputRenderable);
    let dismissed = 0;
    await act(async () => {
      const first = dialog?.show(() => <input id="first" focused />, {
        onDismiss: () => {
          dismissed += 1;
        },
      });
      if (first === undefined) throw new Error("Dialog did not mount");
      completed = pending.promise.then(first.dismiss);
      await setup.renderOnce();
    });
    await act(async () => setup.renderOnce());
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("first");
    await act(async () => {
      dialog?.show(() => <input id="replacement" focused />);
      await setup.renderOnce();
    });
    await act(async () => setup.renderOnce());
    expect(dismissed).toBe(1);
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("replacement");
    await act(async () => {
      pending.resolve(undefined);
      await completed;
    });
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("replacement");
    await act(async () => {
      dialog?.dismiss();
      await setup.renderOnce();
    });
    expect(setup.renderer.currentFocusedRenderable).toBe(composer);
    expect(dismissed).toBe(1);
  } finally {
    pending.resolve(undefined);
    await completed;
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("client teardown retires dialog handles and cancels its owned interaction once", async () => {
  let dialog: ReturnType<typeof useDialog> | undefined;
  let handle: ReturnType<ReturnType<typeof useDialog>["show"]> | undefined;
  let cancelled = 0;
  const setup = await testRender(
    <Harness
      ready={(value) => {
        dialog = value;
      }}
    />,
    { width: 72, height: 20, useKittyKeyboard: null },
  );
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("Chat ready")),
    );
    await act(async () => {
      handle = dialog?.show(() => <text>Pending login</text>, {
        onDismiss: () => {
          cancelled += 1;
        },
      });
      await setup.renderOnce();
    });
    expect(handle?.isCurrent()).toBe(true);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
  expect(cancelled).toBe(1);
  expect(handle?.isCurrent()).toBe(false);
  handle?.dismiss();
  dialog?.dismiss();
  expect(cancelled).toBe(1);
});

test("changing Sessions retires even a dialog that is waiting to cancel", async () => {
  let dialog: ReturnType<typeof useDialog> | undefined;
  let select: (() => void) | undefined;
  let retired = 0;
  const setup = await testRender(
    <Harness
      ready={(value, next) => {
        dialog = value;
        select = next;
      }}
    />,
    { width: 72, height: 20, useKittyKeyboard: null },
  );
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("Chat ready")),
    );
    await act(async () => {
      dialog?.show(() => <text>Old Session dialog</text>, {
        beforeDismiss: () => false,
        onDismiss: () => {
          retired += 1;
        },
      });
      await setup.renderOnce();
    });
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("Old Session dialog");
    await act(async () => {
      select?.();
      await setup.renderOnce();
    });
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).not.toContain("Old Session dialog");
    expect(retired).toBe(1);
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("composer");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
