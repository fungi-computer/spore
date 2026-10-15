import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { openTerminalApplication } from "../src/terminal-application.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { waitForFrame } from "./native-readiness.js";

/** Real input timing: no act() batching between a key and its renders. */
async function raw(
  setup: Awaited<ReturnType<typeof testRender>>,
  press: () => void,
  until: (frame: string) => boolean,
) {
  press();
  for (let pass = 0; pass < 100; pass += 1) {
    await Bun.sleep(5);
    await setup.renderOnce();
    if (until(setup.captureCharFrame())) return true;
  }
  return false;
}

const unused = () => Promise.reject(new Error("unused"));

/** Opus-PS's stress loop as a unit twin: every Ctrl K o picker takes keys. */
test("Ctrl K o opens a picker that takes keys every time (20 opens)", async () => {
  const setup = await testRender(<box />, { width: 100, height: 30 });
  const app = await openTerminalApplication({
    signals: { on: () => undefined, off: () => undefined },
    createQueryClient,
    createRenderer: () => Promise.resolve(setup.renderer),
    createRoot,
    createWhistle,
    enableKeymap: true,
  });
  if (app === undefined) throw new Error("Terminal did not open");
  app.inputHandoff?.pause();
  const fixture = createTuiFixture();
  try {
    await act(async () => {
      app.root.render(
        <QueryClientProvider client={app.queryClient}>
          <TuiFrame
            session={fixture.session}
            commands={app.commands}
            commandHost={app.commandHost}
            onExit={app.exit}
            setQuitGuard={app.setQuitGuard}
            initialTheme="mocha"
            apps={{
              // Local's account read crosses a real await.
              signedIn: () =>
                new Promise((resolve) => {
                  setTimeout(() => {
                    resolve(true);
                  }, 1);
                }),
              read: unused,
              requestGill: unused,
              openUi: unused,
            }}
          />
        </QueryClientProvider>,
      );
      await setup.renderOnce();
    });
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
    const stalls: number[] = [];
    for (let open = 0; open < 20; open += 1) {
      await raw(
        setup,
        () => {
          setup.mockInput.pressKey("k", { ctrl: true });
        },
        (frame) => frame.includes("Open pane"),
      );
      await raw(
        setup,
        () => {
          setup.mockInput.pressKey("o");
        },
        (frame) => frame.includes("▶ Local terminal"),
      );
      if (
        !(await raw(
          setup,
          () => {
            setup.mockInput.pressArrow("down");
          },
          (frame) => frame.includes("▶ Apps"),
        ))
      )
        stalls.push(open);
      await raw(
        setup,
        () => {
          setup.mockInput.pressEscape();
        },
        (frame) => !frame.includes("Local terminal"),
      );
    }
    expect(stalls).toEqual([]);
    expect(setup.captureCharFrame()).toContain("Ask anything");
  } finally {
    await app.close();
  }
}, 60_000);

test("Esc clears a shell notice under the real keymap", async () => {
  const setup = await testRender(<box />, { width: 100, height: 30 });
  const app = await openTerminalApplication({
    signals: { on: () => undefined, off: () => undefined },
    createQueryClient,
    createRenderer: () => Promise.resolve(setup.renderer),
    createRoot,
    createWhistle,
    enableKeymap: true,
  });
  if (app === undefined) throw new Error("Terminal did not open");
  app.inputHandoff?.pause();
  const fixture = createTuiFixture();
  const refused = () => Promise.reject(new Error("App directory refused"));
  try {
    await act(async () => {
      app.root.render(
        <QueryClientProvider client={app.queryClient}>
          <TuiFrame
            session={fixture.session}
            commands={app.commands}
            commandHost={app.commandHost}
            onExit={app.exit}
            setQuitGuard={app.setQuitGuard}
            initialTheme="mocha"
            apps={{
              signedIn: () => Promise.resolve(true),
              read: refused,
              requestGill: refused,
              openUi: refused,
            }}
          />
        </QueryClientProvider>,
      );
      await setup.renderOnce();
    });
    await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
    await raw(
      setup,
      () => {
        setup.mockInput.pressKey("k", { ctrl: true });
      },
      (frame) => frame.includes("Open pane"),
    );
    await raw(
      setup,
      () => {
        setup.mockInput.pressKey("o");
      },
      (frame) => frame.includes("▶ Local terminal"),
    );
    await raw(
      setup,
      () => {
        setup.mockInput.pressArrow("down");
      },
      (frame) => frame.includes("▶ Apps"),
    );
    expect(
      await raw(
        setup,
        () => {
          setup.mockInput.pressEnter();
        },
        (frame) => frame.includes("App directory refused"),
      ),
    ).toBe(true);
    expect(
      await raw(
        setup,
        () => {
          setup.mockInput.pressEscape();
        },
        (frame) => !frame.includes("App directory refused"),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
}, 60_000);
