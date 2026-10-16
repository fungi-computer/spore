import { expect, test, spyOn, describe, beforeAll, afterAll } from "bun:test";
import { act } from "react";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { terminalPalette } from "@fungi.computer/stipe";
import { RGBA } from "@opentui/core";
import { openTerminalApplication } from "../src/terminal-application.js";
import * as paneKit from "../src/button/index.js";
import { TuiFrame } from "../src/frame.js";
import { PaneWorkspace } from "../src/shell/workspace.js";
import { useDialog } from "../src/button/index.js";
import type { createPaneRegistry } from "../src/shell/registry.js";
import { captureFrame } from "./frame-capture.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey, waitForLiveFrame } from "./native-readiness.js";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSync } from "node:fs";
import { WriteStream } from "node:tty";

// The pane runs the person's login shell (that is the product). The test must
// not depend on whose: a hermetic HOME and /bin/sh keep rc files, prompt
// frameworks and slow shell startup out of the expected frames. The profile
// pins a short prompt: macOS's default (host:dir user$) is wider than half of
// the 80x24 pane and wraps the markers the frames wait for.
const ambient = { home: process.env.HOME, shell: process.env.SHELL };
let hermeticHome: string | undefined;
beforeAll(async () => {
  hermeticHome = await mkdtemp(join(tmpdir(), "pty-pane-home-"));
  await writeFile(join(hermeticHome, ".profile"), "PS1='$ '\n");
  process.env.HOME = hermeticHome;
  process.env.SHELL = "/bin/sh";
});
afterAll(async () => {
  if (ambient.home === undefined) delete process.env.HOME;
  else process.env.HOME = ambient.home;
  if (ambient.shell === undefined) delete process.env.SHELL;
  else process.env.SHELL = ambient.shell;
  if (hermeticHome !== undefined)
    await rm(hermeticHome, { recursive: true, force: true });
});

function terminalFocused(
  app: NonNullable<Awaited<ReturnType<typeof openTerminalApplication>>>,
) {
  return app.commandHost
    .active()
    .palette.some((row) => row.title === "Send Ctrl K to shell");
}

async function openConversationTerminal(width: number, height: number) {
  const setup = await testRender(<box />, { width, height });
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
  const frame = (check: (text: string) => boolean) =>
    waitForLiveFrame(setup, check);
  const key = (name: Parameters<typeof setup.mockInput.pressKey>[0]) =>
    pressDecodedKey(setup, () => {
      setup.mockInput.pressKey(name);
    });
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
          />
        </QueryClientProvider>,
      );
      await setup.renderOnce();
    });
    await frame((text) => text.includes("Ask anything"));
    const open = app.commandHost
      .active()
      .palette.find((row) => row.title === "Open pane");
    if (open === undefined) throw new Error("Open pane command missing");
    await act(async () => {
      await app.commandHost.execute(open.commandId, { origin: "menu" });
    });
    await frame((text) => text.includes("Local terminal"));
    await key("ARROW_DOWN");
    await key("RETURN");
    await frame(() => terminalFocused(app));
    return { setup, app, frame, key };
  } catch (cause) {
    await app.close();
    throw cause;
  }
}

type ObservedTerminal = {
  close: () => Promise<void>;
  hasRunningJobs: () => Promise<boolean>;
};

function spyOnSelectedTerminal(
  observe: (terminal: ObservedTerminal) => void,
): () => void {
  if (process.platform === "darwin") {
    const open = paneKit.openMacTerminal;
    const opening = spyOn(paneKit, "openMacTerminal").mockImplementation(
      async (options) => {
        const terminal = await open(options);
        observe(terminal);
        return terminal;
      },
    );
    return () => {
      opening.mockRestore();
    };
  }

  const open = paneKit.openLocalTerminal;
  const opening = spyOn(paneKit, "openLocalTerminal").mockImplementation(
    async (options) => {
      const terminal = await open(options);
      observe(terminal);
      return terminal;
    },
  );
  return () => {
    opening.mockRestore();
  };
}

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  test(`local PTY is a peer pane with exclusive input and idle quit (${String(width)}x${String(height)})`, async () => {
    const output = new WriteStream(openSync("/dev/null", "w"));
    output.isTTY = true;
    const input = Promise.withResolvers<NodeJS.ReadStream>();
    let queries = 0;
    const writes = spyOn(output, "write").mockImplementation((chunk) => {
      const query = chunk.toString();
      let reply = "";
      for (let index = 0; index < 16; index += 1)
        if (query.includes(`\x1b]4;${String(index)};?`))
          reply += `\x1b]4;${String(index)};#cdd6f4\x07`;
      for (const index of [10, 11, 12, 13, 14, 15, 16, 17, 19])
        if (query.includes(`\x1b]${String(index)};?`))
          reply += `\x1b]${String(index)};#${index === 11 ? "1e1e2e" : "cdd6f4"}\x07`;
      if (reply.length > 0) {
        queries += 1;
        void input.promise.then((stream) => {
          stream.emit("data", Buffer.from(reply));
        });
      }
      return true;
    });
    let setupForCleanup: Awaited<ReturnType<typeof testRender>> | undefined;
    let appForCleanup:
      | Exclude<Awaited<ReturnType<typeof openTerminalApplication>>, undefined>
      | undefined;
    const setupState = await (async () => {
      try {
        const setup = await testRender(<box />, {
          width,
          height,
          kittyKeyboard: width === 160,
          stdout: output,
          useThread: false,
        });
        setupForCleanup = setup;
        setup.renderer.stdin.isTTY = true;
        input.resolve(setup.renderer.stdin);
        const application = await openTerminalApplication({
          signals: { on: () => undefined, off: () => undefined },
          createQueryClient,
          createRenderer: () => Promise.resolve(setup.renderer),
          createRoot,
          createWhistle,
          enableKeymap: true,
        });
        if (application === undefined) throw new Error("Terminal did not open");
        appForCleanup = application;
        application.inputHandoff?.pause();
        const fixture = createTuiFixture();
        return { setup, application, fixture };
      } catch (cause) {
        try {
          if (appForCleanup !== undefined)
            await act(async () => {
              await appForCleanup?.close();
            });
          else if (setupForCleanup !== undefined)
            act(() => {
              setupForCleanup?.renderer.destroy();
            });
        } finally {
          writes.mockRestore();
          output.destroy();
        }
        throw cause;
      }
    })();
    const { setup, application, fixture } = setupState;
    const app = application;
    let registry: ReturnType<typeof createPaneRegistry> | undefined;
    const ready = (value: ReturnType<typeof createPaneRegistry>) => {
      registry = value;
      app.setQuitGuard(value.canQuit);
    };
    const sessions = {
      acquire: () => Promise.resolve(fixture.session),
      describe: () => ({ themeName: "mocha" as const }),
    };
    function Shell() {
      const dialog = useDialog();
      return (
        <QueryClientProvider client={app.queryClient}>
          <PaneWorkspace
            commandHost={app.commandHost}
            sessions={sessions}
            theme="mocha"
            exit={app.exit}
            openPane={() => undefined}
            dialog={dialog}
            onRegistry={ready}
          />
        </QueryClientProvider>
      );
    }
    const frame = (check: (text: string) => boolean) =>
      waitForLiveFrame(setup, check);
    const key = (
      name: Parameters<typeof setup.mockInput.pressKey>[0],
      options?: Parameters<typeof setup.mockInput.pressKey>[1],
    ) =>
      pressDecodedKey(setup, () => {
        setup.mockInput.pressKey(name, options);
      });
    const type = (text: string) =>
      act(async () => {
        await setup.mockInput.typeText(text);
        await setup.renderOnce();
      });
    const captures = process.env.PANE_CAPTURE_DIR;
    const capture = (name: string) =>
      captureFrame(
        setup,
        captures,
        `${name}-${String(width)}x${String(height)}`,
      );
    const palette = () =>
      act(async () => {
        const before = queries;
        setup.renderer.clearPaletteCache();
        const colors = await setup.renderer.getPalette({
          size: 16,
          timeout: 300,
        });
        expect(queries).toBeGreaterThan(before);
        expect(colors.defaultForeground).toBe("#cdd6f4");
        expect(colors.defaultBackground).toBe("#1e1e2e");
        expect(colors.palette[4]).toBe("#cdd6f4");
        expect(setup.captureCharFrame()).not.toContain(
          "Terminal palette unavailable",
        );
        const prompt = setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes("Fixture is streaming"));
        const mocha = terminalPalette("mocha");
        if (mocha === undefined) throw new Error("Mocha palette missing");
        const background = Bun.color(mocha.background, "hex");
        if (background === null) throw new Error("Mocha background missing");
        expect(prompt?.bg.toInts()).toEqual(RGBA.fromHex(background).toInts());
      });
    try {
      if (captures !== undefined) await mkdir(captures, { recursive: true });
      await act(async () => {
        application.root.render(<Shell />);
        await setup.renderOnce();
      });
      if (registry === undefined) throw new Error("Registry missing");
      const panes = registry;
      await act(async () => {
        await panes.open({
          kind: "conversation",
          agentId: "local-fixture",
          sessionId: "conversation",
        });
      });
      await frame((text) => text.includes("Ask anything"));
      await type("Keep this conversation running");
      await key("RETURN");
      await frame(() => fixture.promptCalls() === 1);
      await act(async () => {
        fixture.confirmLatestPrompt();
        await setup.renderOnce();
      });
      await frame((text) => text.includes("Fixture is streaming a reply"));
      expect(setup.captureCharFrame()).not.toContain(
        "Terminal palette unavailable",
      );
      await palette();
      await capture("before");
      expect(
        (
          await panes.open({
            kind: "terminal",
            command: "not a shell argument",
          })
        ).kind,
      ).toBe("refused");
      expect(panes.read()).toHaveLength(1);
      let terminalId = "";
      await act(async () => {
        const opened = await panes.open({ kind: "terminal" });
        if (opened.kind === "refused") throw new Error(opened.reason);
        terminalId = opened.paneId;
      });
      await frame(() => terminalFocused(app));
      await palette();
      await type("printf 'LOCAL_%s\\n' READY");
      await key("RETURN");
      await frame((text) => text.includes("LOCAL_READY"));
      await type(
        "stty -echo; printf '\\033[2J\\033[HPANE_SAFE\\n\\033]0;MUTANT_TITLE\\007\\033]52;c;CLIPBOARD_PAYLOAD\\007'",
      );
      await key("RETURN");
      await frame(
        (text) => text.includes("PANE_SAFE") && !text.includes("MUTANT_TITLE"),
      );
      expect(setup.captureCharFrame()).toContain(
        "Fixture is streaming a reply",
      );
      for (const control of ["\x1b", "\x07", "\x9b"])
        expect(setup.captureCharFrame()).not.toContain(control);
      await capture("shell");
      await type("yes PALETTE_OUTPUT");
      await key("RETURN");
      await frame((text) => text.includes("PALETTE_OUTPUT"));
      await palette();
      await key("c", { ctrl: true });
      await type("printf '\\033[2J\\033[HPALETTE_ISOLATED\\n'");
      await key("RETURN");
      await frame((text) => text.includes("PALETTE_ISOLATED"));
      const literal = app.commandHost
        .active()
        .palette.find((row) => row.title === "Send Ctrl K to shell");
      if (literal === undefined) throw new Error("Literal leader missing");
      expect(
        (
          await app.commandHost.execute(literal.commandId, {
            origin: "agent",
          })
        ).status,
      ).toBe("missing");
      await key("k", { ctrl: true });
      await frame((text) => text.includes("All commands"));
      await key("k", { ctrl: true });
      await frame((text) => text.includes("Commands"));
      await type("Send Ctrl K");
      await frame((text) => text.includes("Send Ctrl K to shell"));
      await key("ESCAPE");
      await type(
        "python3 -u -c \"import time; print('INTERRUPT_READY'); time.sleep(60)\"",
      );
      await key("RETURN");
      await frame((text) => text.includes("INTERRUPT_READY"));
      await key("c", { ctrl: true });
      await type("printf 'INTERRUPT%s\\n' ED");
      await key("RETURN");
      await frame((text) => text.includes("INTERRUPTED"));
      expect(application.destroyed()).toBe(false);
      expect(fixture.cancelCalls()).toHaveLength(0);
      expect(fixture.promptCalls()).toBe(1);
      expect(fixture.abortCalls()).toBe(0);
      await act(async () => {
        panes.toggleZoom(terminalId);
        await setup.renderOnce();
      });
      await type("stty size");
      await key("RETURN");
      await frame((text) =>
        text.includes(`${String(height)} ${String(width)}`),
      );
      await capture("zoomed");
      await type(
        `stty raw -echo; python3 -u -c "import os; print('INPUT_READY'); print('LEADER_BYTE_'+str(os.read(0,1)[0])); os.read(0,1)"`,
      );
      await key("RETURN");
      await frame((text) => text.includes("INPUT_READY"));
      await key("k", { ctrl: true });
      await frame((text) => text.includes("All commands"));
      await key("ESCAPE");
      expect(setup.captureCharFrame()).not.toContain("LEADER_BYTE_11");
      await act(async () => {
        await app.commandHost.execute(literal.commandId, { origin: "menu" });
      });
      await frame((text) => text.includes("LEADER_BYTE_11"));
      let closing: Promise<void> | undefined;
      await act(async () => {
        closing = panes.close(terminalId);
        await setup.renderOnce();
      });
      await frame((text) => text.includes("Close local shell"));
      await capture("close-confirmation");
      await key("RETURN");
      await act(async () => {
        await closing;
      });
      expect(panes.read().some((pane) => pane.paneId === terminalId)).toBe(
        true,
      );
      await act(async () => {
        closing = panes.close(terminalId);
        await setup.renderOnce();
      });
      await frame((text) => text.includes("Close local shell"));
      await key("ARROW_DOWN");
      await key("RETURN");
      await act(async () => {
        await closing;
      });
      await frame(
        () => !panes.read().some((pane) => pane.paneId === terminalId),
      );
      await palette();
      expect(panes.read()).toHaveLength(1);
      expect(fixture.cancelCalls()).toHaveLength(0);
      expect(fixture.promptCalls()).toBe(1);
      expect(fixture.abortCalls()).toBe(0);
      await act(async () => {
        await panes.open({ kind: "terminal" });
      });
      await frame(() => terminalFocused(app));
      expect(await panes.canQuit()).toBe(true);
      expect(setup.captureCharFrame()).not.toContain("Quit and terminate");
      const exited = once(app.signal, "abort");
      await act(async () => {
        app.exit();
        await exited;
        await app.close();
      });
      expect(app.destroyed()).toBe(true);
    } finally {
      try {
        await act(async () => {
          await application.close();
        });
      } finally {
        writes.mockRestore();
        output.destroy();
      }
    }
  }, 30_000);
}

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  describe(`ready local PTY (${String(width)}x${String(height)})`, () => {
    let active:
      Awaited<ReturnType<typeof openConversationTerminal>> | undefined;
    let closeCompletion: Promise<void> | undefined;
    let restoreOpening: (() => void) | undefined;
    let pid: string | undefined;

    beforeAll(async () => {
      restoreOpening = spyOnSelectedTerminal((terminal) => {
        const close = terminal.close.bind(terminal);
        terminal.close = () => {
          closeCompletion = close();
          return closeCompletion;
        };
      });
      try {
        active = await openConversationTerminal(width, height);
        const { setup, frame, key } = active;
        await act(async () => {
          await setup.mockInput.pasteBracketedText(
            "sleep 60 & printf 'QUIT_JOB:%s\\n' $!",
          );
        });
        await key("RETURN");
        await frame((text) => /QUIT_JOB:[0-9]+/u.test(text));
        pid = /QUIT_JOB:([0-9]+)/u.exec(setup.captureCharFrame())?.[1];
        if (pid === undefined) throw new Error("Quit job identity missing");
      } catch (cause) {
        try {
          await act(async () => {
            await active?.app.close();
          });
          await closeCompletion;
        } finally {
          restoreOpening();
          restoreOpening = undefined;
        }
        throw cause;
      }
    }, 30_000);

    afterAll(async () => {
      try {
        await act(async () => {
          await active?.app.close();
        });
        await closeCompletion;
      } finally {
        restoreOpening?.();
        restoreOpening = undefined;
      }
    });

    test(`local PTY confirmed jobs quit (${String(width)}x${String(height)})`, async () => {
      if (active === undefined || pid === undefined)
        throw new Error("PTY fixture is not ready");
      const { setup, app, frame, key } = active;
      await act(async () => {
        app.exit();
        await setup.renderOnce();
      });
      await frame((text) => text.includes("Keep shells running"));
      const captures = process.env.PANE_CAPTURE_DIR;
      if (captures !== undefined) await mkdir(captures, { recursive: true });
      await captureFrame(
        setup,
        captures,
        `quit-confirmation-${String(width)}x${String(height)}`,
      );
      // Default Keep is covered by the real composition-root cases below.
      await key("ARROW_DOWN");
      const exited = once(app.signal, "abort");
      await key("RETURN");
      await act(async () => {
        await exited;
        await app.close();
      });
      expect(closeCompletion).toBeDefined();
      await closeCompletion;
      const probe = Bun.spawn(["/bin/ps", "-o", "stat=", "-p", pid], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const state = (await new Response(probe.stdout).text()).trim();
      await probe.exited;
      expect(state.length === 0 || state.startsWith("Z")).toBe(true);
      expect(app.destroyed()).toBe(true);
    });
  });
}

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const) {
  test(`the real conversation composition root guards quit and reports failed inspection (${String(width)}x${String(height)})`, async () => {
    let failInspection = false;
    const restoreOpening = spyOnSelectedTerminal((terminal) => {
      const inspect = terminal.hasRunningJobs.bind(terminal);
      terminal.hasRunningJobs = () =>
        failInspection
          ? Promise.reject(new Error("Job inspection fixture failed"))
          : inspect();
    });
    let active: Awaited<ReturnType<typeof openConversationTerminal>>;
    try {
      active = await openConversationTerminal(width, height);
    } catch (cause) {
      restoreOpening();
      throw cause;
    }
    const { setup, app, frame, key } = active;
    try {
      await act(async () => {
        await setup.mockInput.pasteBracketedText(
          "sleep 60 & printf 'ROOT_JOB:%s\\n' $!",
        );
      });
      await key("RETURN");
      await frame((text) => /ROOT_JOB:[0-9]+/u.test(text));
      const captures = process.env.QUIT_CAPTURE_DIR;
      if (captures !== undefined) await mkdir(captures, { recursive: true });
      await captureFrame(
        setup,
        captures,
        `before-${String(width)}x${String(height)}`,
      );
      failInspection = true;
      await act(async () => {
        await app.commands.execute("tui:exit", { origin: "menu" });
      });
      await frame((text) => text.includes("Could not check shell jobs"));
      expect(app.destroyed()).toBe(false);
      expect(setup.captureCharFrame()).not.toContain(
        "Quit and terminate running shell jobs?",
      );
      await captureFrame(
        setup,
        captures,
        `after-${String(width)}x${String(height)}`,
      );
      failInspection = false;
      await act(async () => {
        await app.commands.execute("tui:exit", { origin: "menu" });
      });
      await frame((text) => text.includes("Keep shells running"));
      await key("RETURN");
      await frame((text) => !text.includes("Keep shells running"));
      expect(app.destroyed()).toBe(false);
      await act(async () => {
        await app.commands.execute("tui:exit", { origin: "menu" });
      });
      await frame((text) => text.includes("Keep shells running"));
      await key("ARROW_DOWN");
      const exited = once(app.signal, "abort");
      await key("RETURN");
      await act(async () => {
        await exited;
        await app.close();
      });
      expect(app.destroyed()).toBe(true);
    } finally {
      try {
        await act(async () => {
          await app.close();
        });
      } finally {
        restoreOpening();
      }
    }
  });
}

test("closing an idle local shell closes at once, without asking to terminate jobs", async () => {
  const { setup, app, frame } = await openConversationTerminal(80, 24);
  try {
    // Programs get the pane, without host titles or persistent key hints.
    expect(setup.captureCharFrame()).not.toContain("Local machine");
    expect(setup.captureCharFrame()).not.toContain("Ctrl C interrupt");
    expect(setup.captureCharFrame()).not.toContain("pane commands");
    const close = app.commandHost
      .active()
      .palette.find((row) => row.title === "Close pane");
    if (close === undefined) throw new Error("Close pane command missing");
    await act(async () => {
      await app.commandHost.execute(close.commandId, { origin: "menu" });
    });
    await frame(() => !terminalFocused(app));
    expect(setup.captureCharFrame()).not.toContain("terminate its jobs");
  } finally {
    await app.close();
  }
});
