import { expect, test } from "bun:test";
import { act, useState } from "react";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import {
  Landing,
  type LandingProps,
  type LandingChoice,
  type LandingSummary,
} from "../src/landing.js";
import { HostColorsContext } from "../src/button/dialog-surface.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import type { ThemeName } from "../src/button/theme-preferences.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";
import { captureFrame } from "./frame-capture.js";

function ThemedLanding({
  theme,
  ...props
}: LandingProps & { theme: ThemeName }) {
  const presentation = useTerminalTheme(theme);
  return (
    <HostColorsContext.Provider value={presentation.colors}>
      <Landing {...props} />
    </HostColorsContext.Provider>
  );
}

function viewport(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node;
  for (const child of node.getChildren()) {
    const found = viewport(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

const sessions = Array.from({ length: 40 }, (_, index) => ({
  databasePath: "/hidden/store.sqlite",
  sessionId: `session-${String(index)}`,
  title: `Conversation ${String(index + 1).padStart(2, "0")}`,
  createdAt: 1,
  updatedAt: 2,
  resume: () => Promise.reject(new Error("Rendering must not open a Session")),
}));

for (const theme of ["latte", "mocha"] as const) {
  for (const { width, height } of [
    { width: 80, height: 24 },
    { width: 120, height: 36 },
    { width: 160, height: 48 },
  ]) {
    test(`landing keeps rows and hints visible and scrolls at ${String(width)}x${String(height)} in ${theme}`, async () => {
      const picked: (LandingChoice | undefined)[] = [];
      const summary = Promise.withResolvers<LandingSummary>();
      const setup = await testRender(
        <ThemedLanding
          theme={theme}
          sessions={sessions}
          folder="/project/a-folder-that-is-long-enough-to-exercise-the-folder-row-without-hiding-the-list"
          loadSummary={() => summary.promise}
          choose={(choice) => {
            picked.push(choice);
          }}
        />,
        { width, height, exitOnCtrlC: false },
      );
      try {
        await waitForFrame(setup, (frame) => frame.includes("Checking…"));
        expect(setup.captureCharFrame()).toContain("+ New session");
        act(() => {
          summary.resolve({ account: undefined, model: undefined });
        });
        const frame = await waitForFrame(setup, (value) =>
          value.includes("Not signed in"),
        );
        expect(frame).toContain("None yet");
        expect(frame).toContain("Conversation 01");
        expect(frame).toContain("Enter open");
        expect(frame).toContain("n new session");
        expect(frame).toContain("Esc quit");
        expect(frame).not.toContain("/hidden/store");
        for (let remaining = sessions.length; remaining > 0; remaining -= 1)
          await pressDecodedKey(setup, () => {
            setup.mockInput.pressArrow("down");
          });
        const scrolled = await waitForFrame(setup, (value) =>
          value.includes("Conversation 40"),
        );
        expect(scrolled).toContain("Conversation 40");
        expect(scrolled).toContain("Esc quit");
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressEnter();
        });
        expect(picked.pop()).toEqual({ kind: "resume", index: 39 });
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressKey("n");
        });
        expect(picked.pop()).toEqual({ kind: "new" });
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressEscape();
        });
        expect(picked).toEqual([undefined]);
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressKey("c", { ctrl: true });
        });
        expect(picked).toEqual([undefined, undefined]);
        const originalViewport = viewport(setup.renderer.root);
        expect(originalViewport).toBeDefined();
        act(() => {
          setup.resize(80, 24);
        });
        const resized = await waitForFrame(
          setup,
          (value) =>
            value.includes("fungi · Your ideas") &&
            value.includes("Esc quit") &&
            value.includes("Conversation 40"),
        );
        expect(resized).toContain("Esc quit");
        expect(resized).toContain("▶ Conversation 40");
        expect(viewport(setup.renderer.root)).toBe(originalViewport);
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressEnter();
        });
        expect(picked.pop()).toEqual({ kind: "resume", index: 39 });
        act(() => {
          setup.resize(160, 48);
        });
        await waitForFrame(
          setup,
          (value) =>
            value.includes("▶ Conversation 40") && value.includes("Esc quit"),
        );
        expect(viewport(setup.renderer.root)).toBe(originalViewport);
        await pressDecodedKey(setup, () => {
          setup.mockInput.pressEnter();
        });
        expect(picked.pop()).toEqual({ kind: "resume", index: 39 });
      } finally {
        act(() => {
          setup.renderer.destroy();
        });
      }
    });
  }
}

test("landing lists several Agents and picks one with Enter", async () => {
  const picked: (LandingChoice | undefined)[] = [];
  const setup = await act(async () =>
    testRender(
      <ThemedLanding
        theme="mocha"
        sessions={[]}
        agents={[
          {
            agentId: "local_store_first",
            databasePath: "/hidden/first/agent.sqlite",
            sessionCount: 3,
            updatedAt: 2,
            unreadable: "predates the current schema",
          },
          {
            agentId: "local_store_second",
            name: "fixer",
            createdBy: "Shiitake",
            databasePath: "/hidden/second/agent.sqlite",
            sessionCount: 0,
          },
        ]}
        folder="/project"
        loadSummary={() =>
          Promise.resolve({ account: undefined, model: undefined })
        }
        choose={(choice) => {
          picked.push(choice);
        }}
      />,
      { width: 100, height: 30, exitOnCtrlC: false },
    ),
  );
  try {
    const frame = await waitForFrame(setup, (value) => value.includes("fixer"));
    expect(frame).toContain("Agents in this folder");
    expect(frame).toContain("fixer, made by Shiitake");
    // The picker column is narrow, so the reason is cut with an ellipsis.
    expect(frame).toContain("local_store_first (unreadable:");
    expect(frame).toContain("local_store_first");
    expect(frame).toContain("3 conversations");
    expect(frame).toContain("0 conversations");
    expect(frame).not.toContain("+ New session");
    expect(frame).not.toContain("/hidden");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    expect(picked).toEqual([{ kind: "agent", index: 1 }]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("after picking an Agent the conversations list starts on + New session", async () => {
  const agents = [
    {
      agentId: "local_store_first",
      databasePath: "/hidden/first/agent.sqlite",
      sessionCount: 1,
    },
    {
      agentId: "local_store_second",
      databasePath: "/hidden/second/agent.sqlite",
      sessionCount: 1,
    },
  ];
  const conversation = {
    databasePath: "/hidden/second/agent.sqlite",
    sessionId: "talk",
    title: "Second talk",
    createdAt: 1,
    updatedAt: 2,
    resume: () =>
      Promise.reject(new Error("Rendering must not open a Session")),
  };
  function Flow() {
    const [chosen, setChosen] = useState<boolean>(false);
    return (
      <ThemedLanding
        theme="mocha"
        sessions={chosen ? [conversation] : []}
        agents={chosen ? agents.slice(1) : agents}
        folder="/project"
        loadSummary={() =>
          Promise.resolve({ account: undefined, model: undefined })
        }
        choose={(choice) => {
          if (choice?.kind === "agent") setChosen(true);
        }}
      />
    );
  }
  const setup = await act(async () =>
    testRender(<Flow />, {
      width: 100,
      height: 30,
      exitOnCtrlC: false,
    }),
  );
  try {
    await waitForFrame(setup, (value) => value.includes("local_store_second"));
    await captureFrame(
      setup,
      process.env.TUI_UX_CAPTURE_DIR,
      "populated-agents-before",
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    await waitForFrame(setup, (value) =>
      value.includes("▶ local_store_second"),
    );
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressEnter();
    });
    const frame = await waitForFrame(setup, (value) =>
      value.includes("Recent conversations"),
    );
    expect(frame).toContain("▶ + New session");
    await captureFrame(
      setup,
      process.env.TUI_UX_CAPTURE_DIR,
      "populated-agents-after",
    );
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("landing archives the highlighted Agent with a, and shows why a refused archive did nothing", async () => {
  const picked: (LandingChoice | undefined)[] = [];
  const setup = await act(async () =>
    testRender(
      <ThemedLanding
        theme="mocha"
        sessions={[]}
        agents={[
          {
            agentId: "local_store_first",
            databasePath: "/hidden/first/agent.sqlite",
            sessionCount: 3,
          },
          {
            agentId: "local_store_second",
            name: "fixer",
            databasePath: "/hidden/second/agent.sqlite",
            sessionCount: 0,
          },
        ]}
        notice="command command_9 is running; cancel it first"
        folder="/project"
        loadSummary={() =>
          Promise.resolve({ account: undefined, model: undefined })
        }
        choose={(choice) => {
          picked.push(choice);
        }}
      />,
      { width: 100, height: 30, exitOnCtrlC: false },
    ),
  );
  try {
    const frame = await waitForFrame(setup, (value) => value.includes("fixer"));
    expect(frame).toContain("a archive");
    expect(frame).toContain("command command_9 is running");
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressArrow("down");
    });
    await pressDecodedKey(setup, () => {
      setup.mockInput.pressKey("a");
    });
    expect(picked).toEqual([{ kind: "archive", index: 1 }]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
