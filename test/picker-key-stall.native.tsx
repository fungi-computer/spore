import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { createRoot } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { openTerminalApplication } from "../src/terminal-application.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";

/** Real input timing: no act() batching between a key and its renders. */
async function raw(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
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

async function composerReady(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
) {
  // The production renderer has a live frame clock; the component test SDK
  // instead supplies act flushes. Keep the original 2000ms startup bound.
  setup.renderer.start();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      setup.waitForFrame((frame) => frame.includes("Ask anything")),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Composer was not rendered within 2000ms"));
        }, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Production-root stress: no second React test root or component act harness. */
async function repeatedPicker() {
  const setup = await createTestRenderer({ width: 100, height: 30 });
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
    {
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
    }
    await composerReady(setup);
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
    assert.deepEqual(stalls, []);
    assert.ok(setup.captureCharFrame().includes("Ask anything"));
  } finally {
    await app.close();
  }
}

async function dismissNotice() {
  const setup = await createTestRenderer({ width: 100, height: 30 });
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
    {
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
    }
    await composerReady(setup);
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
    assert.equal(
      await raw(
        setup,
        () => {
          setup.mockInput.pressEnter();
        },
        (frame) => frame.includes("App directory refused"),
      ),
      true,
    );
    assert.equal(
      await raw(
        setup,
        () => {
          setup.mockInput.pressEscape();
        },
        (frame) => !frame.includes("App directory refused"),
      ),
      true,
    );
  } finally {
    await app.close();
  }
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { scenario: { type: "string" } },
});
switch (values.scenario) {
  case "repeat":
    await repeatedPicker();
    break;
  case "notice":
    await dismissNotice();
    break;
  default:
    throw new Error("Expected --scenario repeat or notice");
}
console.info(`picker-key-stall ${values.scenario}: passed`);
