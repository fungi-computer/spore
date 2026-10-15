import { executeAlias } from "./command-selection.js";
import { waitForFrame } from "./native-readiness.js";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { setTimeout as wait } from "node:timers/promises";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import {
  CodeRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
  RGBA,
} from "@opentui/core";

import { TuiFrame } from "@fungi.computer/tui/frame";
import {
  createDesignTuiFixture,
  longHistoryDesignSnapshot,
  failedToolDesignSnapshot,
  toolDisclosuresDesignSnapshot,
  groupedToolsDesignSnapshot,
  runningToolsDesignSnapshot,
} from "./design-fixture.ts";
import { captureFrame } from "./frame-capture.ts";
import { fixtureClients } from "./fixture.ts";
import { contributeTerminalExitCommands } from "../dist/button/terminal-exit.js";

const output = process.env.DESIGN_CAPTURE_DIR;
if (output) await mkdir(output, { recursive: true });

const manyArgumentSource = toolDisclosuresDesignSnapshot.messages.at(-1);
assert.ok(manyArgumentSource && manyArgumentSource.value.role === "assistant");
const manyArgumentCall = manyArgumentSource.value.content.find(
  (part) => part.type === "toolCall",
);
assert.ok(manyArgumentCall);
const manyToolArgumentsDesignSnapshot = {
  ...toolDisclosuresDesignSnapshot,
  messages: [
    ...toolDisclosuresDesignSnapshot.messages.slice(0, -1),
    {
      ...manyArgumentSource,
      value: {
        ...manyArgumentSource.value,
        content: [
          {
            ...manyArgumentCall,
            arguments: Object.fromEntries(
              Array.from({ length: 12 }, (_, index) => [
                `code${String(index + 1)}`,
                "return await terminal.render({ width: 48, height: 18 });",
              ]),
            ),
          },
        ],
      },
    },
  ],
};

function renderedNodes(node) {
  return [node, ...node.getChildren().flatMap(renderedNodes)];
}

async function finishHighlighting(node) {
  await Promise.all(
    renderedNodes(node)
      .filter((child) => child instanceof CodeRenderable)
      .map((child) => child.highlightingDone),
  );
}

function assertUserSurface(setup) {
  const scroll = renderedNodes(setup.renderer.root).find(
    (node) => node instanceof ScrollBoxRenderable,
  );
  assert.ok(scroll);
  const lines = setup.captureSpans().lines;
  const lineIndex = lines.findIndex((row) =>
    row.spans.some((span) => span.text.includes("Review the terminal")),
  );
  const line = lines[lineIndex];
  assert.ok(line);
  const userText = renderedNodes(setup.renderer.root).find(
    (node) =>
      node instanceof TextRenderable &&
      node.plainText.includes("Review the terminal"),
  );
  const agentText = renderedNodes(setup.renderer.root).find(
    (node) =>
      node instanceof TextRenderable &&
      node.plainText.includes("I’ll inspect the current frame"),
  );
  assert.ok(userText && agentText);
  assert.equal(
    userText.x,
    agentText.x,
    "user and agent text share one timeline column",
  );
  const content = line.spans.find((span) =>
    span.text.includes("Review the terminal"),
  );
  assert.ok(content && content.bg.equals(RGBA.fromHex("#282839")));
  const coversViewport = (row) => {
    const cells = row.spans.flatMap((span) => Array(span.width).fill(span));
    return cells
      .slice(scroll.viewport.x, scroll.viewport.x + scroll.viewport.width)
      .every((cell) => cell.bg.equals(content.bg));
  };
  assert.ok(
    coversViewport(line),
    "user surface covers both viewport edges, padding and text",
  );
  assert.doesNotMatch(line.spans.map((span) => span.text).join(""), /●/u);
  const userRow = renderedNodes(setup.renderer.root).find(
    (node) => node.id === "tui-timeline-row:design-user-layout",
  );
  assert.ok(userRow);
  const contentHeight = Math.max(
    ...userRow.getChildren().map((child) => child.height),
  );
  assert.equal(
    userRow.height,
    contentHeight + 2,
    "user surface retains one native padding row above and below its content",
  );
}

async function settlePresentation(setup, client) {
  await act(async () => {
    await Promise.all(
      client
        .getQueryCache()
        .findAll({ queryKey: ["tui-tool-code"] })
        .map((query) => query.promise),
    );
  });
  await setup.waitForVisualIdle();
  await finishHighlighting(setup.renderer.root);
  await setup.renderOnce();
}

async function toggleAllDetails(setup, client, commands) {
  let outcome;
  await act(async () => {
    outcome = await executeAlias(commands, "details", {
      origin: "programmatic",
    });
  });
  assert.equal(outcome?.status, "handled");
  await settlePresentation(setup, client);
}

async function destroyTui(setup, client, commands) {
  await act(async () => {
    setup.renderer.destroy();
  });
  client.clear();
  commands.close();
}

const toolLine = /script|execute/u;

/** The footer names the running tool too; transcript rows are the targets. */
const footerLine = /Goal ·|● running /u;

function assertToolTone(setup, hex) {
  const line = setup.captureSpans().lines.findLast((line) => {
    const text = line.spans.map((span) => span.text).join("");
    return toolLine.test(text) && !footerLine.test(text);
  });
  // Grouped calls draw a status glyph; a lone call draws a dot.
  const dot = line?.spans.find((span) => /[●✓✗◌]/u.test(span.text));
  assert.ok(
    dot?.fg.equals(RGBA.fromHex(hex)),
    JSON.stringify({
      line: line?.spans.map((span) => span.text).join(""),
      dot: dot?.fg.toInts(),
    }),
  );
}

/** The live status row is drawn beneath the composer; returns its spans. */
function statusRow(setup, status, width) {
  const lines = setup.captureSpans().lines;
  const input = renderedNodes(setup.renderer.root).find(
    (node) => node instanceof TextareaRenderable,
  );
  const row = lines.findIndex((line, index) => {
    const text = line.spans
      .map((span) => span.text)
      .join("")
      .trimStart();
    return (
      input !== undefined &&
      index > input.y &&
      (text.startsWith("● " + status) ||
        text.startsWith(status + " ") ||
        (width < 80 && text.includes("Enter send")))
    );
  });
  assert.ok(
    input && row > input.y,
    `Expected ${status} below composer at ${input?.y}:\n${setup.captureCharFrame()}`,
  );
  return lines[row];
}

function assertStatusAndGoalRow(setup, width, status = "streaming") {
  const line = statusRow(setup, status, width);
  const text = line.spans.map((span) => span.text).join("");
  assert.doesNotMatch(text, /Goal active/u);
  assert.match(
    setup.captureCharFrame(),
    width < 48
      ? /Polish the terminal review · G…/u
      : /Polish the terminal review · Goal · active/u,
  );
  // Model identity stays ahead of shortcuts at every width.
  if (width >= 80 && (width >= 100 || status !== "waiting"))
    assert.ok(text.includes("auto"), text);
  assert.doesNotMatch(text, /Alt\+Enter/u);
  if (width >= 100) assert.match(text, /Enter send.*PgUp\/PgDn scroll/u);
}

async function clickLastTool(setup, pattern = toolLine) {
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findLastIndex(
    (line) => pattern.test(line) && !footerLine.test(line),
  );
  assert.ok(y >= 0, "tool disclosure is visible");
  await setup.mockMouse.click(lines[y].search(/\S/u), y);
}

/** Expanded call bodies render code; collapsed rows are one text line. */
function hasCode(setup, text) {
  return renderedNodes(setup.renderer.root).some(
    (node) => node instanceof CodeRenderable && node.content.includes(text),
  );
}

async function capture(setup, name) {
  await captureFrame(setup, output, name);
}

for (const [width, height] of [
  [80, 40],
  [48, 30],
  [33, 23],
]) {
  const fixture = createDesignTuiFixture();
  const commands = createWhistle();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let exits = 0;
  const exited = Promise.withResolvers();
  const exit = () => {
    exits += 1;
    exited.resolve();
  };
  const exitLease = contributeTerminalExitCommands(commands, {
    exit,
    ctrlC: () => {
      exit();
      return Promise.resolve();
    },
  });
  const setup = await testRender(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TuiFrame, {
        clients: fixtureClients,
        commands,
        initialTheme: "mocha",
        session: fixture.session,
        onExit: exit,
      }),
    ),
    { width, height },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await waitForFrame(setup, (frame) => frame.includes("newest response"));
    await finishHighlighting(setup.renderer.root);
    await setup.renderOnce();
    await act(async () => {
      await setup.mockInput.typeText("Keep the code easy to read.");
    });
    await waitForFrame(setup, (frame) => frame.includes("easy to read."));
    await setup.waitForVisualIdle();
    if (width === 80) assertToolTone(setup, "#a6e3a1");
    const composer = setup
      .captureSpans()
      .lines.find((line) => line.spans.some((span) => span.text.includes("›")));
    assert.ok(composer);
    const promptMark = composer.spans.find((span) => span.text.includes("›"));
    const inputText = composer.spans.find((span) =>
      span.text.includes("easy to read."),
    );
    assert.ok(promptMark && inputText && promptMark.bg.equals(inputText.bg));
    assertStatusAndGoalRow(setup, width);
    await capture(setup, `native-${width}x${height}`);
    for (
      let page = 0;
      page < 8 && !setup.captureCharFrame().includes("Review the terminal");
      page += 1
    ) {
      await act(async () => {
        setup.mockInput.pressKey("\x1b[5~");
        await setup.renderOnce();
      });
    }
    assert.match(setup.captureCharFrame(), /Review the terminal/);
    assertUserSurface(setup);
    await capture(setup, `history-${width}x${height}`);
    await toggleAllDetails(setup, client, commands);
    await setup.waitForVisualIdle();
    assert.match(setup.captureCharFrame(), /easy to read\./);
    await capture(setup, `details-${width}x${height}`);
    const nodes = renderedNodes(setup.renderer.root);
    const code = nodes.find(
      (node) =>
        node instanceof CodeRenderable &&
        node.content.includes("const contents ="),
    );
    const scroll = nodes.find((node) => node instanceof ScrollBoxRenderable);
    assert.ok(code && scroll);
    assert.equal(code.filetype, "typescript");
    assert.match(code.content, /;\nreturn contents;/);
    // A script row shows its source, then its output; no argument dump.
    assert.equal(
      nodes.some(
        (node) => node instanceof CodeRenderable && node.filetype === "json",
      ),
      false,
    );
    scroll.scrollBy(code.y - scroll.viewport.y - 2);
    await settlePresentation(setup, client);
    assert.match(setup.captureCharFrame(), /return contents;/);
    assert.doesNotMatch(setup.captureCharFrame(), /"code":|\\nreturn/);
    assert.ok(
      setup
        .captureSpans()
        .lines.some((line) =>
          line.spans.some(
            (span) =>
              span.text.includes("const") &&
              span.fg.equals(RGBA.fromHex("#f5c2e7")),
          ),
        ),
    );
    assert.doesNotMatch(setup.captureCharFrame(), /^\s+result\b|truncated/mu);
    await capture(setup, `expanded-code-${width}x${height}`);
    // The read result is a numbered excerpt, not a JSON envelope.
    const content = renderedNodes(setup.renderer.root).find(
      (node) =>
        node instanceof TextRenderable &&
        node.plainText.includes("import { useState }"),
    );
    assert.ok(content);
    assert.equal(
      content.plainText,
      '1 import { useState } from "react";\n2 \n3 export const status = "ready";',
    );
    scroll.scrollBy(content.y - scroll.viewport.y - 2);
    await settlePresentation(setup, client);
    assert.match(
      setup.captureCharFrame(),
      /3 export const status\s*=\s*"ready"/,
    );
    assert.doesNotMatch(setup.captureCharFrame(), /\\n|\\"react/);
    await capture(setup, `formatted-result-${width}x${height}`);
    const baseline = await fixture.session.read();
    const running = {
      queue: { state: "running", commandId: "design-command" },
      cancellationRequested: false,
      retry: null,
      activeTool: null,
      lastModelChoiceSequence: null,
      compaction: null,
    };
    const footerActivities = {
      queued: {
        ...running,
        queue: {
          state: "queued",
          commandId: "design-queued",
          runningWork: null,
        },
      },
      thinking: running,
      retrying: {
        ...running,
        retry: {
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2_000,
          errorMessage: "overloaded",
          scheduledAt: Date.now(),
        },
      },
      cancelling: { ...running, cancellationRequested: true },
      idle: { ...running, queue: { state: "idle" } },
    };
    // The footer's text is Parakeet's view state; each begins with this word.
    const footerWords = {
      queued: "waiting",
      thinking: "thinking",
      retrying: "retrying",
      cancelling: "cancelling",
      idle: "idle",
    };
    for (const status of Object.keys(footerActivities)) {
      await act(async () => {
        fixture.pushFrame({
          kind: "reset",
          reason: "history_unavailable",
          cursor: baseline.cursor,
          baseline: {
            ...baseline,
            activity: footerActivities[status],
            progress: null,
          },
        });
      });
      await waitForFrame(setup, (frame) =>
        frame.split("\n").some((line) => {
          const text = line.trimStart();
          return (
            (width < 80 && text.includes("Enter send")) ||
            text.startsWith(`● ${footerWords[status]}`) ||
            text.startsWith(`${footerWords[status]} `)
          );
        }),
      );
      assertStatusAndGoalRow(setup, width, footerWords[status]);
    }
    await capture(setup, `idle-footer-${width}x${height}`);
    await act(async () => {
      fixture.pushFrame({
        pending: { total: 0, prompts: [], hasMore: false },
        kind: "update",
        attention: [],
        delivery: "live",
        cursor: "design-cursor-goal-only",
        messages: [],
        terminals: [],
        activity: {
          queue: { state: "idle" },
          cancellationRequested: false,
          retry: null,
          activeTool: null,
          lastModelChoiceSequence: null,
          compaction: null,
        },
        extensions: {
          "botanical-session-goal": {
            ...baseline.extensions["botanical-session-goal"],
            value: {
              ...baseline.extensions["botanical-session-goal"].value,
              goal: {
                revision: "design-goal",
                objective: "Polish the terminal review",
                state: "paused",
                stopReason: null,
              },
            },
          },
        },
      });
      await setup.renderOnce();
    });
    await waitForFrame(setup, (frame) =>
      frame.includes(
        width < 48 ? "Polish the terminal review · G…" : "Goal · paused",
      ),
    );
    assert.match(
      setup.captureCharFrame(),
      width < 48 ? /Polish the terminal review · G…/u : /Goal · paused/u,
    );
    const pausedGoalRow = setup
      .captureSpans()
      .lines.find((line) =>
        line.spans.some((span) =>
          span.text.includes(
            width < 48 ? "Polish the terminal review · G…" : "Goal · paused",
          ),
        ),
      );
    assert.ok(pausedGoalRow);
    assert.match(
      pausedGoalRow.spans.map((span) => span.text).join(""),
      width < 48
        ? /Polish the terminal review · G…/u
        : /Polish the terminal review · Goal · paused/u,
    );
    await capture(setup, `paused-goal-row-${width}x${height}`);
    assert.equal(fixture.watchCalls(), 1);
    await act(async () => {
      const outcome = await executeAlias(commands, "exit", {
        origin: "programmatic",
      });
      assert.equal(outcome.status, "handled");
      await Promise.race([
        exited.promise,
        wait(1000).then(() => {
          throw new Error("Exit command did not finish");
        }),
      ]);
    });
    assert.equal(exits, 1);
  } finally {
    exitLease.dispose();
    await destroyTui(setup, client, commands);
  }
  await fixture.waitForClose();
  assert.equal(fixture.closeCalls(), 1);
}

for (const [name, snapshot, width, tone] of [
  ["long-running", longHistoryDesignSnapshot, 48, "#89b4fa"],
  ["tool-error", failedToolDesignSnapshot, 33, "#f38ba8"],
  ["tool-disclosure", toolDisclosuresDesignSnapshot, 48, "#89b4fa"],
  ["many-tool-arguments", manyToolArgumentsDesignSnapshot, 48, "#89b4fa"],
]) {
  const fixture = createDesignTuiFixture({ snapshot });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const setup = await testRender(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TuiFrame, {
        clients: fixtureClients,
        commands,
        session: fixture.session,
        initialTheme: "mocha",
      }),
    ),
    { width, height: 24 },
  );
  const resizeWarnings = [];
  const captureResizeWarning = (warning) => {
    if (warning.name === "MaxListenersExceededWarning") {
      resizeWarnings.push(warning);
    }
  };
  const grouped = ["tool-disclosure", "many-tool-arguments"].includes(name);
  if (grouped) process.on("warning", captureResizeWarning);
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await waitForFrame(setup, (frame) => toolLine.test(frame));
    await finishHighlighting(setup.renderer.root);
    await setup.renderOnce();
    // The failed call opens by default and pushes the prose above the fold.
    if (name === "long-running") {
      assert.match(setup.captureCharFrame(), /native\s+render\s+check/);
    }
    await act(async () => {
      await setup.mockInput.typeText("Continue after the render check.");
    });
    await waitForFrame(setup, (frame) => frame.includes("render check."));
    assertToolTone(setup, tone);
    // A failed call opens by default; running and finished rows stay closed.
    const initiallyOpen = name === "tool-error";
    assert.equal(hasCode(setup, "terminal.render"), initiallyOpen);
    await capture(setup, `${name}-${width}x24`);
    // A group holding a running call opens by default; finished groups do not.
    const groupStartsOpen = name === "many-tool-arguments";
    if (groupStartsOpen)
      assert.match(setup.captureCharFrame(), /✓ Ran script/u);
    else
      await act(async () => {
        await clickLastTool(setup);
      });
    await settlePresentation(setup, client);
    if (grouped) {
      // The group opens onto one compact row per call; bodies stay closed.
      assert.match(setup.captureCharFrame(), /✓ Ran script/u);
      assert.equal(hasCode(setup, "files.read"), false);
    } else {
      assert.equal(hasCode(setup, "terminal.render"), !initiallyOpen);
    }
    await capture(setup, `${name}-details-${width}x24`);

    await toggleAllDetails(setup, client, commands);
    const expanded = groupStartsOpen || !(grouped || !initiallyOpen);
    assert.equal(hasCode(setup, "terminal.render"), expanded);
    await toggleAllDetails(setup, client, commands);
    assert.equal(hasCode(setup, "terminal.render"), !expanded);
    if (expanded) await toggleAllDetails(setup, client, commands);
    // Everything expanded: every call body is drawn.
    if (name === "tool-disclosure") assert.ok(hasCode(setup, "files.read"));
    if (name === "many-tool-arguments") {
      assert.equal(
        setup.renderer.listenerCount("resize"),
        1,
        "expanded tool arguments share TuiFrame terminal dimensions",
      );
      assert.deepEqual(resizeWarnings, []);
      assert.ok(hasCode(setup, '"code12"'), "all arguments are shown");
      await act(async () => {
        setup.resize(80, 24);
        await setup.renderOnce();
      });
      await settlePresentation(setup, client);
      assertStatusAndGoalRow(setup, 80, "streaming");
      assert.equal(setup.renderer.listenerCount("resize"), 1);
      assert.deepEqual(resizeWarnings, []);
    }

    if (name === "tool-disclosure") {
      await capture(setup, "independent-tool-disclosure-48x24");
      await act(async () => {
        await setup.mockInput.typeText(" Focus retained.");
      });
      await setup.renderOnce();
      assert.match(setup.captureCharFrame(), /Focus\s+retained\./);

      const source = toolDisclosuresDesignSnapshot.messages.at(-1);
      assert.equal(source.value.role, "assistant");
      const arrive = async (number) => {
        await act(async () => {
          fixture.pushFrame({
            pending: { total: 0, prompts: [], hasMore: false },
            kind: "update",
            attention: [],
            delivery: "live",
            cursor: `incoming-${number}`,
            activity: {
              queue: { state: "running", commandId: "design-command" },
              cancellationRequested: false,
              retry: null,
              activeTool: null,
              lastModelChoiceSequence: null,
              compaction: null,
            },
            terminals: [],
            extensions: toolDisclosuresDesignSnapshot.extensions,
            messages: [
              {
                ...source,
                id: `incoming-assistant-${number}`,
                sequence: source.sequence + number,
                value: {
                  ...source.value,
                  content: [
                    {
                      type: "toolCall",
                      id: `incoming-call-${number}`,
                      name: `execute-${number}`,
                      arguments: { code: `return 'incoming-${number}';` },
                    },
                  ],
                },
              },
            ],
          });
        });
        await waitForFrame(setup, (frame) =>
          frame.includes(`execute-${number}`),
        );
        await settlePresentation(setup, client);
        assert.equal(
          setup.renderer.listenerCount("resize"),
          1,
          "newly arriving tools reuse TuiFrame terminal dimensions",
        );
      };
      const hasIncomingDetails = (number) =>
        hasCode(setup, `return 'incoming-${number}';`);
      await arrive(1);
      assert.ok(
        hasIncomingDetails(1),
        "expand-all applies to a newly arriving tool",
      );
      await act(async () => {
        await clickLastTool(setup, /Calling execute-1/u);
      });
      await settlePresentation(setup, client);
      assert.ok(
        !hasIncomingDetails(1),
        "one incoming tool can still be collapsed individually",
      );
      await arrive(2);
      assert.ok(
        hasIncomingDetails(2),
        "an individual collapse does not disable expand-all",
      );
      assert.ok(
        !hasIncomingDetails(1),
        "new arrivals preserve individual choices",
      );
      await toggleAllDetails(setup, client, commands);
      await arrive(3);
      assert.ok(
        !hasIncomingDetails(3),
        "collapse-all also applies to future tools",
      );
      await toggleAllDetails(setup, client, commands);
      assert.ok(
        [1, 2, 3].every(hasIncomingDetails),
        "expand-all clears individual exceptions",
      );
      assert.deepEqual(resizeWarnings, []);
    }
    assert.match(setup.captureCharFrame(), /render check\./);
  } finally {
    process.off("warning", captureResizeWarning);
    await destroyTui(setup, client, commands);
  }
  await fixture.waitForClose();
  assert.equal(fixture.closeCalls(), 1);
  assert.equal(setup.renderer.listenerCount("resize"), 0);
}
for (const [name, snapshot, ready] of [
  ["tool-group-failed", groupedToolsDesignSnapshot, "1 failed"],
  ["tool-group-running", runningToolsDesignSnapshot, "Running pnpm"],
]) {
  const fixture = createDesignTuiFixture({ snapshot });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const setup = await testRender(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TuiFrame, {
        clients: fixtureClients,
        commands,
        session: fixture.session,
        initialTheme: "mocha",
      }),
    ),
    { width: 100, height: 48 },
  );
  try {
    await act(async () => setup.renderOnce());
    await waitForFrame(setup, (frame) => frame.includes(ready));
    await settlePresentation(setup, client);
    await capture(setup, `${name}-100x48`);
    // Expand-all draws every call body, the diff included; then collapse-all.
    await toggleAllDetails(setup, client, commands);
    await capture(setup, `${name}-expanded-100x48`);
    await toggleAllDetails(setup, client, commands);
    await capture(setup, `${name}-collapsed-100x48`);
  } finally {
    await destroyTui(setup, client, commands);
  }
  await fixture.waitForClose();
}

process.stdout.write(
  "Native TUI design frames captured; focus, scrolling, Escape and one-watch lifecycle passed.\n",
);
