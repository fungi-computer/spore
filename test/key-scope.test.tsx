import { expect, test } from "bun:test";
import { act, useRef } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { TextareaRenderable } from "@opentui/core";
import { createAppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import {
  z,
  PaneProvider,
  useDialog,
  useNativeFocus,
  type PaneKindEntry,
} from "../src/button/index.js";
import { PaneWorkspace } from "../src/shell/workspace.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { waitForFrame } from "./native-readiness.js";

/** KeyScope: one stack, a Dialog above the focused pane, native focus following it. */
const editors = new Map<string, TextareaRenderable>();

function Editor({ name }: Readonly<{ name: string }>) {
  const ref = useRef<TextareaRenderable | null>(null);
  useNativeFocus(ref, { enabled: true });
  return (
    <textarea
      ref={(value: TextareaRenderable | null) => {
        ref.current = value;
        if (value !== null) editors.set(name, value);
      }}
      height={1}
      placeholder={`${name} editor`}
    />
  );
}

const kind: PaneKindEntry = {
  kind: "editor",
  instantiate: (target) => {
    const name = z.object({ name: z.string() }).parse(target).name;
    return {
      key: name,
      title: name,
      render: (kit) => (
        <PaneProvider kit={kit}>
          <Editor name={name} />
        </PaneProvider>
      ),
    };
  },
};

test("native focus follows the focused pane, and closing a Dialog restores the pane, not the old editor", async () => {
  editors.clear();
  const host = createAppSurfaceCommandHost();
  let registry: ReturnType<typeof createPaneRegistry> | undefined;
  let dialogs: ReturnType<typeof useDialog> | undefined;
  const onRegistry = (value: ReturnType<typeof createPaneRegistry>) => {
    registry = value;
  };
  const sessions = {
    acquire: () => Promise.reject(new Error("No Session")),
  };
  const kinds = [kind];
  function Shell() {
    const dialog = useDialog();
    dialogs = dialog;
    return (
      <PaneWorkspace
        kinds={kinds}
        commandHost={host}
        sessions={sessions}
        theme="mocha"
        exit={() => undefined}
        openPane={() => undefined}
        dialog={dialog}
        onRegistry={onRegistry}
      />
    );
  }
  const setup = await testRender(<Shell />, { width: 100, height: 20 });
  const focusedName = () =>
    [...editors].find(
      ([, editor]) => setup.renderer.currentFocusedRenderable === editor,
    )?.[0];
  try {
    if (registry === undefined) throw new Error("Registry missing");
    const panes = registry;
    const opened = async (name: string) => {
      let paneId = "";
      await act(async () => {
        const outcome = await panes.open({ kind: "editor", name });
        if (outcome.kind === "refused") throw new Error(outcome.reason);
        paneId = outcome.paneId;
      });
      return paneId;
    };
    const first = await opened("first");
    await waitForFrame(setup, () => focusedName() === "first");
    await opened("second");
    await waitForFrame(setup, () => focusedName() === "second");
    expect(editors.get("first")?.focused).toBe(false);

    // A Dialog holds the keyboard: no pane editor keeps native focus.
    const { dialog } = await act(() => ({
      dialog: dialogs?.show(() => <text>modal</text>),
    }));
    await waitForFrame(setup, (frame) => frame.includes("modal"));
    expect(focusedName()).toBeUndefined();
    // Focus moves under the Dialog; closing it restores that pane's editor.
    act(() => {
      panes.focus(first);
    });
    act(() => {
      dialog?.dismiss();
    });
    await waitForFrame(setup, () => focusedName() === "first");
    expect(editors.get("second")?.focused).toBe(false);
  } finally {
    await act(async () => {
      await registry?.dispose();
    });
    act(() => {
      setup.renderer.destroy();
    });
    host.dispose();
  }
});
