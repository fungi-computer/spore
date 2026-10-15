import { useEffect, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createAppSurfaceCommandHost } from "@fungi.computer/oyster/shell/command-host";
import { PaneWorkspace } from "../src/shell/workspace.js";
import { PaneProvider, useDialog, reportFailure } from "../src/button/index.js";
import type { createPaneRegistry } from "../src/shell/registry.js";

/** Component tests run inside the same pane renderer/input owner as the CLI. */
export async function testPaneRender(
  node: ReactNode,
  options: Parameters<typeof testRender>[1],
) {
  const host = createAppSurfaceCommandHost();
  const kinds = [
    {
      kind: "component-fixture",
      instantiate: () => ({
        key: "component",
        title: "Component",
        render: (kit: Parameters<typeof PaneProvider>[0]["kit"]) => (
          <PaneProvider kit={kit}>{node}</PaneProvider>
        ),
      }),
    },
  ];
  const sessions = {
    acquire: () => Promise.reject(new Error("Component has no Session")),
  };
  let opened: Promise<unknown> | undefined;
  const ready = (registry: ReturnType<typeof createPaneRegistry>) => {
    opened = registry.open({ kind: "component-fixture" });
  };
  function Host() {
    const dialog = useDialog();
    useEffect(
      () => () => {
        host.dispose();
      },
      [],
    );
    return (
      <PaneWorkspace
        commandHost={host}
        kinds={kinds}
        sessions={sessions}
        theme="mocha"
        exit={() => undefined}
        openPane={() => undefined}
        dialog={dialog}
        onRegistry={ready}
      />
    );
  }
  const setup = await testRender(<Host />, options);
  if (opened === undefined) throw new Error("Component pane did not open");
  try {
    await opened;
    await setup.renderOnce();
  } catch (cause) {
    setup.renderer.destroy();
    reportFailure("component-pane-test", cause);
    throw cause;
  }
  return setup;
}
