import { expect, test } from "bun:test";
import { act } from "react";
import { createAppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import { testRender } from "@opentui/react/test-utils";
import { useDialog, type PaneKit } from "../src/button/index.js";
import { PaneWorkspace } from "../src/shell/workspace.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";

test("a shell Notice draws in its tone, never blocks keys, and the next key clears it", async () => {
  const host = createAppSurfaceCommandHost();
  let registry: ReturnType<typeof createPaneRegistry> | undefined;
  let kit: PaneKit | undefined;
  const keys: string[] = [];
  const onRegistry = (value: ReturnType<typeof createPaneRegistry>) => {
    registry = value;
  };
  const sessions = { acquire: () => Promise.reject(new Error("No Session")) };
  const kinds = [
    {
      kind: "quiet",
      instantiate: () => ({
        key: "quiet",
        title: "Quiet",
        render: (mounted: PaneKit) => {
          kit = mounted;
          mounted.input.onKey((event) => {
            keys.push(event.name);
            return true;
          });
          return <text>quiet</text>;
        },
      }),
    },
  ];
  function Shell() {
    const dialog = useDialog();
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
  const setup = await testRender(<Shell />, { width: 80, height: 12 });
  try {
    await act(async () => {
      await registry?.open({ kind: "quiet" });
    });
    await waitForFrame(setup, (frame) => frame.includes("quiet"));
    act(() => {
      kit?.notify({ tone: "warning", message: "Heads up" });
    });
    await waitForFrame(setup, (frame) => frame.includes("Heads up"));
    const span = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((candidate) => candidate.text.includes("Heads up"));
    // The workspace draws its own palette: a warning is not the error color.
    const mocha = span?.fg.toInts();
    expect(mocha).toBeDefined();
    act(() => {
      kit?.notify({ tone: "error", message: "Broken" });
    });
    await waitForFrame(setup, (frame) => frame.includes("Broken"));
    const error = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((candidate) => candidate.text.includes("Broken"))
      ?.fg.toInts();
    expect(mocha).not.toEqual(error);
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("z");
    });
    await waitForFrame(setup, (frame) => !frame.includes("Broken"));
    expect(keys).toEqual(["z"]);
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
