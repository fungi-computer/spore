import { expect, test } from "bun:test";
import { setTimeout as settle } from "node:timers/promises";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import {
  createWhistle,
  createWhistleKeymapAdapter,
  type WhistleKeymapHost,
} from "@fungi.computer/whistle";
import type { SessionSnapshot } from "@fungi.computer/shiitake/client";
import { act } from "react";
import { z } from "zod";
import { DiffRenderable, RGBA, type Renderable } from "@opentui/core";
import { terminalPalette } from "@fungi.computer/stipe";
import { toolCallView } from "@fungi.computer/parakeet/headless";
import { TuiFrame } from "../src/frame.js";
import { captureFrame } from "./frame-capture.js";
import { captureCells, captureSigilPlacements } from "./frame-cells.js";
import { loadToolSigils } from "../src/tool-sigils.js";
import { sigilGutterTotalWidth, type ToolSigils } from "../src/button/index.js";

// Every row's inset is 1. A tool icon's own image spans three columns --
// one reclaimed from the pane's left inset, plus the existing two-cell
// gutter -- so its origin sits one cell before the inset.
const sigilX = 0;
const textX = 1 + sigilGutterTotalWidth;

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}
import {
  createDesignTuiFixture,
  groupedToolsDesignSnapshot,
  runningToolsDesignSnapshot,
} from "./design-fixture.js";

async function mount(
  snapshot: SessionSnapshot,
  width = 100,
  watchFailure?: Error,
  toolSigils?: ToolSigils,
  height = 72,
) {
  const fixture = createDesignTuiFixture({ snapshot });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const commands = createWhistle();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <TuiFrame
        session={
          watchFailure === undefined
            ? fixture.session
            : { ...fixture.session, watch: () => Promise.reject(watchFailure) }
        }
        commands={commands}
        toolSigils={toolSigils}
        initialTheme="mocha"
      />
    </QueryClientProvider>,
    { width, height },
  );
  // The same native keymap adapter the terminal application installs.
  const nativeKeymap = createDefaultOpenTuiKeymap(setup.renderer);
  const keymap = createWhistleKeymapAdapter(
    {
      registerLayer: (layer) =>
        nativeKeymap.registerLayer({
          ...layer,
          target: setup.renderer.root,
          priority: 100,
        }),
    } satisfies WhistleKeymapHost,
    commands,
    "keyboard",
  );
  await act(async () => setup.renderOnce());
  return {
    setup,
    dispose: () => {
      keymap.cleanup();
      act(() => {
        setup.renderer.destroy();
      });
      client.clear();
      commands.close();
    },
  };
}

async function frameAfter(
  setup: Awaited<ReturnType<typeof testRender>>,
  change: () => void | Promise<void>,
): Promise<string> {
  await act(async () => {
    await change();
  });
  await act(async () => {
    await settle(20);
    await setup.renderOnce();
  });
  return setup.captureCharFrame();
}

test("consecutive calls render as one group; a failure opens it on the failed call", async () => {
  const { setup, dispose } = await mount(groupedToolsDesignSnapshot);
  try {
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("6 calls")),
    );
    const frame = setup.captureCharFrame();
    expect(frame.match(/6 calls/gu)).toHaveLength(1);
    expect(frame).toContain("1 failed");
    expect(frame).toContain("Read apps/tui/src/frame.tsx");
    expect(frame).toContain("Ran pnpm --dir apps/tui run test · exit 1");
    // The failed call opens error-first with one bounded output block.
    expect(frame).toMatch(/▾\s+✗ groups fold consecutive calls/u);
    expect(frame).toContain("$ pnpm --dir apps/tui run test");
    expect(frame).toContain("✓ transcript row 12");
    expect(frame).toContain("… 8 more lines");
    expect(frame).not.toMatch(/result|exitCode|truncated/u);
    expect(frame).not.toContain('export const status = "ready"');

    const collapsed = await frameAfter(setup, () => {
      setup.mockInput.pressKey("g", { ctrl: true });
    });
    expect(collapsed).toContain("Read 2 files, searched 1 pattern");
    expect(collapsed).not.toContain("Read apps/tui/src/frame.tsx");
    expect(collapsed).toContain("Ran pnpm --dir apps/tui run test");

    const reopened = await frameAfter(setup, () => {
      setup.mockInput.pressKey("g", { ctrl: true });
    });
    expect(reopened).toContain("Read apps/tui/src/frame.tsx");

    const lines = reopened.split("\n");
    const y = lines.findIndex((line) =>
      line.includes("Updated apps/tui/src/transcript.tsx"),
    );
    expect(y).toBeGreaterThanOrEqual(0);
    const diff = await frameAfter(setup, () =>
      setup.mockMouse.click(lines[y]?.indexOf("Updated") ?? 0, y),
    );
    expect(diff).toMatch(/\+ +const tone = statusTone\(item.status/u);
    expect(diff).toMatch(/- +const tone = colors.info;/u);
    expect(diff).not.toMatch(/Success\.|"status"/u);
    // OpenTUI's diff view draws exactly the headless unified patch.
    const drawn = descendants(setup.renderer.root).filter(
      (node) => node instanceof DiffRenderable,
    );
    const patchCall = groupedToolsDesignSnapshot.messages
      .flatMap((message) =>
        message.value.role === "assistant" ? message.value.content : [],
      )
      .find((part) => part.type === "toolCall" && part.name === "apply_patch");
    if (patchCall?.type !== "toolCall") throw new Error("fixture patch");
    const patch = z.string().parse(patchCall.arguments.patch);
    const section = toolCallView({
      args: { patch },
      id: patchCall.id,
      kind: "tool",
      name: patchCall.name,
      status: "running",
    }).sections[0];
    if (section?.kind !== "diff") throw new Error("expected a diff");
    expect(drawn.map((node) => node.diff)).toEqual(
      section.files.map((file) => file.unified),
    );
  } finally {
    dispose();
  }
});

test("a running group shows completed calls beside its live line", async () => {
  const { setup, dispose } = await mount(runningToolsDesignSnapshot);
  try {
    await act(async () =>
      setup.waitForFrame((frame) =>
        frame.includes("Running pnpm --dir apps/tui run typecheck"),
      ),
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("5 calls");
    expect(frame).toContain("Read apps/tui/src/frame.tsx");
    expect(frame).toContain("Running pnpm --dir apps/tui run typecheck");
  } finally {
    dispose();
  }
});

test("a one-file patch diff shows its path header", async () => {
  const sourceCall = groupedToolsDesignSnapshot.messages.find(
    (message) => message.id === "assistant-group-patch",
  );
  const sourceResult = groupedToolsDesignSnapshot.messages.find(
    (message) => message.id === "result-group-patch",
  );
  if (
    sourceCall?.value.role !== "assistant" ||
    sourceResult?.value.role !== "toolResult"
  )
    throw new Error("missing grouped patch fixture");
  const patch = [
    "*** Begin Patch",
    "*** Update File: one-file.ts",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  const snapshot: SessionSnapshot = {
    ...groupedToolsDesignSnapshot,
    messages: [
      ...groupedToolsDesignSnapshot.messages.slice(0, 2),
      {
        ...sourceCall,
        value: {
          ...sourceCall.value,
          content: [
            {
              type: "toolCall",
              id: "group-patch",
              name: "apply_patch",
              arguments: { patch },
            },
          ],
        },
      },
      sourceResult,
    ],
  };
  const { setup, dispose } = await mount(snapshot, 48);
  try {
    await captureFrame(
      setup,
      process.env.TUI_FILE_EDIT_CAPTURE_DIR,
      "files-single-before",
    );
    await frameAfter(setup, () => {
      setup.mockInput.pressKey("o", { ctrl: true });
    });
    await captureFrame(
      setup,
      process.env.TUI_FILE_EDIT_CAPTURE_DIR,
      "files-single-after",
    );
    const frame = setup.captureSpans();
    expect(
      frame.lines.some(
        (line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .trim() === "one-file.ts",
      ),
    ).toBe(true);
    const drawn = descendants(setup.renderer.root).filter(
      (node) => node instanceof DiffRenderable,
    );
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.diff).toContain("+new");
  } finally {
    dispose();
  }
});

for (const width of [33, 48])
  for (const path of [
    "notes.txt",
    `${"unbroken".repeat(12)}.txt`,
    "control.txt",
  ])
    test(`a stored Files edit result uses one native diff for ${path} at ${String(width)} columns`, async () => {
      const sourceCall = groupedToolsDesignSnapshot.messages.find(
        (message) => message.id === "assistant-group-patch",
      );
      const sourceResult = groupedToolsDesignSnapshot.messages.find(
        (message) => message.id === "result-group-patch",
      );
      if (
        sourceCall?.value.role !== "assistant" ||
        sourceResult?.value.role !== "toolResult"
      )
        throw new Error("missing grouped edit fixture");
      const unifiedPatch = [
        `Index: ${path}`,
        "===================================================================",
        `--- ${path}\t`,
        `+++ ${path}\t`,
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      const transportedPatch =
        path === "control.txt"
          ? unifiedPatch.replace(
              "+new",
              "+new\u001b]52;c;Y21k\u0007\u001b[2J\u202e",
            )
          : unifiedPatch;
      const snapshot: SessionSnapshot = {
        ...groupedToolsDesignSnapshot,
        messages: [
          ...groupedToolsDesignSnapshot.messages.slice(0, 2),
          {
            ...sourceCall,
            value: {
              ...sourceCall.value,
              content: [
                {
                  type: "toolCall",
                  id: "group-patch",
                  name: "execute",
                  arguments: {
                    code: `return await files.edit({ path: ${JSON.stringify(path)}, oldText: 'old', newText: 'new' });`,
                  },
                },
              ],
            },
          },
          {
            ...sourceResult,
            value: {
              ...sourceResult.value,
              toolName: "execute",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    path,
                    bytes: 4,
                    diff: "-1 old\n+1 new",
                    firstChangedLine: 1,
                    unifiedPatch: transportedPatch,
                    unifiedPatchBytes: Buffer.byteLength(transportedPatch),
                    unifiedPatchAddedLines: 1,
                    unifiedPatchRemovedLines: 1,
                    unifiedPatchTruncated: false,
                  }),
                },
              ],
            },
          },
        ],
      };
      const { setup, dispose } = await mount(snapshot, width);
      try {
        await frameAfter(setup, () => {
          setup.mockInput.pressKey("o", { ctrl: true });
        });
        const drawn = descendants(setup.renderer.root).filter(
          (node) => node instanceof DiffRenderable,
        );
        expect(drawn.map((node) => node.diff)).toEqual([unifiedPatch]);
        expect(setup.captureCharFrame()).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
        expect(setup.captureCharFrame()).not.toContain("unifiedPatchBytes");
        await captureFrame(
          setup,
          process.env.TUI_FILE_EDIT_CAPTURE_DIR,
          `files-edit-${path === "notes.txt" ? "short" : "long"}-${String(width)}`,
        );
        const frame = setup.captureSpans();
        const capturedText = frame.lines
          .map((line) => line.spans.map((span) => span.text).join(""))
          .join("\n");
        const compact = capturedText.replaceAll(" ", "").replaceAll("\n", "");
        expect(compact).toContain(`${path}1-old1+new`);
        const palette = terminalPalette("mocha");
        if (palette === undefined) throw new Error("Mocha terminal theme");
        const expectedAdded = RGBA.fromHex(palette.success);
        expectedAdded.a = 0.14;
        const expectedRemoved = RGBA.fromHex(palette.error);
        expectedRemoved.a = 0.14;
        expect(drawn[0]?.addedBg.toInts()).toEqual(expectedAdded.toInts());
        expect(drawn[0]?.removedBg.toInts()).toEqual(expectedRemoved.toInts());
        const oldLine = frame.lines.find((line) =>
          line.spans.some((span) => span.text === "old"),
        );
        const newLine = frame.lines.find((line) =>
          line.spans.some((span) => span.text === "new"),
        );
        const oldSpan = oldLine?.spans.find((span) => span.text === "old");
        const newSpan = newLine?.spans.find((span) => span.text === "new");
        expect(oldLine).toBeDefined();
        expect(newLine).toBeDefined();
        const background = RGBA.fromHex(palette.background).toInts();
        const expectedTint = (color: string) =>
          RGBA.fromHex(color)
            .toInts()
            .slice(0, 3)
            .map((channel, index) =>
              Math.round(channel * 0.14 + (background[index] ?? 0) * 0.86),
            );
        expect(oldSpan?.bg.toInts().slice(0, 3)).toEqual(
          expectedTint(palette.error),
        );
        expect(newSpan?.bg.toInts().slice(0, 3)).toEqual(
          expectedTint(palette.success),
        );
      } finally {
        dispose();
      }
    });

for (const width of [33, 48])
  test(`multi-file operation and rename identities survive at ${String(width)} columns`, async () => {
    const sourceCall = groupedToolsDesignSnapshot.messages.find(
      (message) => message.id === "assistant-group-patch",
    );
    const sourceResult = groupedToolsDesignSnapshot.messages.find(
      (message) => message.id === "result-group-patch",
    );
    if (
      sourceCall?.value.role !== "assistant" ||
      sourceResult?.value.role !== "toolResult"
    )
      throw new Error("missing grouped patch fixture");
    const patch = [
      "*** Begin Patch",
      "*** Update File: old-path.txt",
      "*** Move to: new-path.txt",
      "*** Delete File: deleted.txt",
      "*** Add File: added.txt",
      "+added content",
      "*** End Patch",
    ].join("\n");
    const snapshot: SessionSnapshot = {
      ...groupedToolsDesignSnapshot,
      messages: [
        ...groupedToolsDesignSnapshot.messages.slice(0, 2),
        {
          ...sourceCall,
          value: {
            ...sourceCall.value,
            content: [
              {
                type: "toolCall",
                id: "group-patch",
                name: "apply_patch",
                arguments: { patch },
              },
            ],
          },
        },
        sourceResult,
      ],
    };
    const { setup, dispose } = await mount(snapshot, width);
    try {
      await frameAfter(setup, () => {
        setup.mockInput.pressKey("o", { ctrl: true });
      });
      await captureFrame(
        setup,
        process.env.TUI_FILE_EDIT_CAPTURE_DIR,
        `files-multiple-${String(width)}`,
      );
      const frame = setup
        .captureCharFrame()
        .replaceAll(" ", "")
        .replaceAll("\n", "");
      expect(frame).toContain("Updateold-path.txt→new-path.txt");
      expect(frame).toContain("Deletedeleted.txt");
      expect(frame).toContain("Addadded.txt");
      const section = toolCallView({
        args: { patch },
        id: "group-patch",
        kind: "tool",
        name: "apply_patch",
        status: "completed",
      }).sections[0];
      if (section?.kind !== "diff")
        throw new Error("Expected native patch diff");
      expect(section.files[0]).toMatchObject({
        path: "old-path.txt",
        moveTo: "new-path.txt",
        unified: "",
      });
      const drawn = descendants(setup.renderer.root).filter(
        (node) => node instanceof DiffRenderable,
      );
      expect(drawn.map((node) => node.diff)).toEqual(
        section.files
          .filter((file) => file.unified !== "")
          .map((file) => file.unified),
      );
      expect(frame).toContain("+addedcontent");
    } finally {
      dispose();
    }
  });

for (const role of ["user", "assistant"] as const) {
  test(`native ${role} transcript drops terminal controls without dropping readable content`, async () => {
    const source = groupedToolsDesignSnapshot.messages.find(
      (message) => message.value.role === role,
    );
    if (source?.value.role !== role)
      throw new Error("Transcript fixture unavailable");
    const text =
      "before \u001b]0;forged\u0007safe \u001b]52;c;Y21k\u0007message\u001b[2J\u009b2J\u202e end";
    const value =
      source.value.role === "user"
        ? { ...source.value, content: text }
        : { ...source.value, content: [{ type: "text" as const, text }] };
    const snapshot: SessionSnapshot = {
      ...groupedToolsDesignSnapshot,
      messages: [{ ...source, value }],
      progress: null,
    };
    const { setup, dispose } = await mount(snapshot);
    try {
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("safe")),
      );
      const screen = setup.captureCharFrame();
      expect(screen).toContain("before");
      expect(screen).toContain("safe");
      expect(screen).toContain("message");
      expect(screen).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .map((span) => span.text)
          .join(""),
      ).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
    } finally {
      dispose();
    }
  });
}

for (const tool of ["read", "execute", "apply_patch", "custom"] as const) {
  test(`native ${tool} tool display cannot emit terminal controls`, async () => {
    const sourceCall = groupedToolsDesignSnapshot.messages.find(
      (message) => message.value.role === "assistant",
    );
    const sourceResult = groupedToolsDesignSnapshot.messages.find(
      (message) => message.value.role === "toolResult",
    );
    if (
      sourceCall?.value.role !== "assistant" ||
      sourceResult?.value.role !== "toolResult"
    )
      throw new Error("Tool fixture unavailable");
    const frames: string[] = [];
    for (const payload of [
      "",
      "\u001b]52;c;Y21k\u0007\u001b[2J\u001b[H\u202e",
    ]) {
      const argumentsByTool = {
        read: { path: `safe${payload}.txt` },
        execute: { code: `return 'safe${payload}';` },
        apply_patch: {
          patch: `*** Begin Patch\n*** Update File: safe.txt\n@@\n-before\n+safe${payload}\n*** End Patch`,
        },
        custom: { input: `safe${payload}` },
      };
      const snapshot: SessionSnapshot = {
        ...groupedToolsDesignSnapshot,
        messages: [
          {
            ...sourceCall,
            value: {
              ...sourceCall.value,
              content: [
                {
                  type: "toolCall",
                  id: "security-call",
                  name: tool === "custom" ? `custom${payload}` : tool,
                  arguments: argumentsByTool[tool],
                },
              ],
            },
          },
          {
            ...sourceResult,
            value: {
              ...sourceResult.value,
              toolCallId: "security-call",
              toolName: tool,
              isError: true,
              content: [{ type: "text", text: `safe${payload} output` }],
            },
          },
        ],
      };
      const { setup, dispose } = await mount(snapshot);
      try {
        await act(async () =>
          setup.waitForFrame((frame) => frame.includes("safe")),
        );
        await act(async () => {
          await settle(50);
          await setup.renderOnce();
        });
        const screen = setup.captureCharFrame();
        expect(screen).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
        expect(
          setup
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .map((span) => span.text)
            .join(""),
        ).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
        frames.push(screen);
      } finally {
        dispose();
      }
    }
    if (tool === "read") expect(frames[1]).toBe(frames[0]);
    for (const frame of frames) expect(frame).toContain("safe");
  });
}

test("expanded thinking is terminal-safe", async () => {
  const source = groupedToolsDesignSnapshot.messages.find(
    (message) => message.value.role === "assistant",
  );
  if (source?.value.role !== "assistant")
    throw new Error("Assistant fixture unavailable");
  const snapshot: SessionSnapshot = {
    ...groupedToolsDesignSnapshot,
    messages: [
      {
        ...source,
        value: {
          ...source.value,
          content: [
            {
              type: "thinking",
              thinking: "safe\u001b]52;c;Y21k\u0007\u202e reasoning",
            },
            { type: "text", text: "A normal response." },
          ],
        },
      },
    ],
    progress: null,
  };
  const { setup, dispose } = await mount(snapshot);
  try {
    await frameAfter(setup, () => {
      setup.mockInput.pressKey("o", { ctrl: true });
    });
    const screen = setup.captureCharFrame();
    expect(screen).toContain("safe reasoning");
    expect(screen).not.toMatch(/[^\P{Cc}\n\t]|\p{Cf}/u);
  } finally {
    dispose();
  }
});

for (const state of ["observation unavailable", "stopped cause"] as const) {
  test(`native transcript sanitizes ${state} from the real Session`, async () => {
    const payload = "safe\u001b]52;c;Y21k\u0007\u009d\u0090\u202e end";
    const snapshot: SessionSnapshot = {
      ...groupedToolsDesignSnapshot,
      messages: [],
      progress: null,
      terminals:
        state === "stopped cause"
          ? [
              {
                commandId: "failed",
                outcome: "failed",
                sequence: 99,
                diagnostic: payload,
              },
            ]
          : [],
    };
    const { setup, dispose } = await mount(
      snapshot,
      100,
      state === "observation unavailable" ? new Error(payload) : undefined,
    );
    try {
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("safe")),
      );
      const screen = setup.captureCharFrame();
      expect(screen).toContain("safe end");
      expect(screen).not.toMatch(/[^\P{Cc}\n\t]|[\u202a-\u202e\u2066-\u2069]/u);
    } finally {
      dispose();
    }
  });
}

for (const width of [80, 160]) {
  test(`run disclosure carets share one fixed right column (${String(width)} cols)`, async () => {
    const { setup, dispose } = await mount(groupedToolsDesignSnapshot, width);
    try {
      await act(async () =>
        setup.waitForFrame((frame) => frame.includes("6 calls")),
      );
      const rows = setup
        .captureCharFrame()
        .split("\n")
        .filter((row) => /[▸▾]\s*$/u.test(row));
      expect(rows.length).toBeGreaterThan(2);
      const columns = rows.map((row) =>
        Math.max(row.indexOf("▸"), row.indexOf("▾")),
      );
      expect(new Set(columns).size).toBe(1);
      expect(columns[0]).toBeGreaterThan(width - 8);
    } finally {
      dispose();
    }
  });
}

for (const count of [2, 3, 5])
  test(`finished ${String(count)}-call group uses normal rows and a trailing expander only above three`, async () => {
    const messages = groupedToolsDesignSnapshot.messages.filter(
      (message) => !message.id.includes("group-test"),
    );
    const snapshot = {
      ...groupedToolsDesignSnapshot,
      messages: messages.slice(0, 2 + count * 2),
    };
    const { setup, dispose } = await mount(snapshot);
    try {
      await frameAfter(setup, () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Read 2 files");
      const callLines = frame
        .split("\n")
        .filter((line) =>
          /Read apps|Searched ToolRow|Updated apps|Ran pnpm/u.test(line),
        );
      expect(callLines.length).toBeGreaterThan(0);
      for (const line of callLines) {
        expect(line).toMatch(/● ▸\s*$/u);
        expect(
          line.search(/Read apps|Searched ToolRow|Updated apps|Ran pnpm/u),
        ).toBe(textX);
      }
      const leadLine = frame
        .split("\n")
        .find((line) => line.includes("Show all"));
      if (leadLine !== undefined) {
        expect(leadLine).not.toContain("·");
        expect(leadLine.indexOf("Show all")).toBe(textX);
        expect(leadLine.trim()).toBe("Show all 5 calls");
      }
      if (count <= 3) {
        expect(frame).toContain("Read apps/tui/src/frame.tsx");
        expect(frame).not.toContain("Show all");
        expect(frame).toContain(`· ${String(count)} calls`);
      } else {
        expect(frame).not.toContain("Read apps/tui/src/frame.tsx");
        expect(frame).toContain("Searched ToolRow");
        expect(frame).toContain("Show all 5 calls");
        const lines = frame.split("\n");
        const y = lines.findIndex((line) => line.includes("Show all 5 calls"));
        expect(y).toBeGreaterThan(
          lines.findIndex((line) => line.includes("Ran pnpm")),
        );
        const expanded = await frameAfter(setup, () =>
          setup.mockMouse.click(10, y),
        );
        expect(expanded).toContain("Read apps/tui/src/frame.tsx");
        expect(expanded).toContain("Show less");
        const expandedY = expanded
          .split("\n")
          .findIndex((line) => line.includes("Show less"));
        const folded = await frameAfter(setup, () =>
          setup.mockMouse.click(10, expandedY),
        );
        expect(folded).not.toContain("Read apps/tui/src/frame.tsx");
        expect(folded).toContain("Show all 5 calls");
      }
    } finally {
      dispose();
    }
  });

for (const [width, height] of [
  [80, 24],
  [160, 48],
] as const)
  test(`native tool rows align one gutter sigil and message-column text at ${String(width)} columns`, async () => {
    const sigils = await loadToolSigils(() => undefined);
    const snapshot = {
      ...groupedToolsDesignSnapshot,
      messages: groupedToolsDesignSnapshot.messages.map((message) =>
        message.value.role === "toolResult" && message.value.isError
          ? {
              ...message,
              value: {
                ...message.value,
                content: [{ type: "text" as const, text: "failed" }],
              },
            }
          : message,
      ),
    };
    const { setup, dispose } = await mount(
      snapshot,
      width,
      undefined,
      sigils,
      height,
    );
    try {
      await frameAfter(setup, () => setup.renderOnce());
      const frame = captureCells(setup);
      // The transcript stays pinned to the latest message; at this
      // fixture's shorter height an earlier reply can scroll out of view,
      // so anchor on the conversation's last reply instead.
      const messageY = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("I’ll fix the failing assertion"));
      expect(messageY).toBeGreaterThanOrEqual(0);
      expect(
        frame.cells.find((cell) => cell.y === messageY && cell.x === textX)
          ?.text,
      ).toBe("O");
      const placements = captureSigilPlacements(frame);
      // One group summary and six call rows, not one image per placeholder cell.
      expect(placements).toHaveLength(7);
      expect(new Set(placements.map((cell) => cell.y)).size).toBe(7);
      for (const origin of placements) {
        expect(origin.x).toBe(sigilX);
        expect(origin.text).toBe("\u{10eeee}\u0305\u0305");
        const continuation = frame.cells.find(
          (cell) => cell.y === origin.y && cell.x === origin.x + 1,
        );
        expect(continuation?.text).toBe("\u{10eeee}\u0305\u030d");
        expect(continuation?.fg).toEqual(origin.fg);
        const textCell = frame.cells.find(
          (cell) => cell.y === origin.y && cell.x === textX,
        );
        expect(textCell?.text).toMatch(/[A-Z]/u);
      }
    } finally {
      dispose();
    }
  });

for (const { name, snapshot, label, color } of [
  {
    name: "completed",
    snapshot: groupedToolsDesignSnapshot,
    label: "Read apps/tui/src/frame.tsx",
    color: "#a6e3a1",
  },
  {
    name: "failed",
    snapshot: groupedToolsDesignSnapshot,
    label: "Ran pnpm --dir apps/tui run test",
    color: "#f38ba8",
  },
  {
    name: "running",
    snapshot: runningToolsDesignSnapshot,
    label: "Running pnpm --dir apps/tui run typecheck",
    color: "#89b4fa",
  },
  {
    name: "unknown",
    snapshot: {
      ...groupedToolsDesignSnapshot,
      messages: groupedToolsDesignSnapshot.messages.filter(
        (message) => message.id !== "result-group-read-frame",
      ),
    },
    label: "Read apps/tui/src/frame.tsx",
    color: "#cdd6f4",
  },
])
  test(`native ${name} status uses the existing Parakeet theme colour on a dot`, async () => {
    const { setup, dispose } = await mount(snapshot);
    try {
      await frameAfter(setup, () => setup.renderOnce());
      const lines = setup.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(label));
      expect(y).toBeGreaterThanOrEqual(0);
      const status = captureCells(setup).cells.find(
        (cell) => cell.y === y && cell.text === "●",
      );
      expect(status?.fg).toEqual(RGBA.fromHex(color).toInts());
      expect(lines[y]).not.toMatch(/[✓✗]/u);
    } finally {
      dispose();
    }
  });

for (const width of [80, 160])
  test(`a single tool call draws one gutter row and toggles its body (${String(width)} cols)`, async () => {
    const sigils = await loadToolSigils(() => undefined);
    const snapshot = {
      ...groupedToolsDesignSnapshot,
      messages: groupedToolsDesignSnapshot.messages
        .slice(0, 4)
        .map((message) =>
          message.value.role === "toolResult"
            ? {
                ...message,
                value: {
                  ...message.value,
                  content: [{ type: "text" as const, text: "Passed" }],
                },
              }
            : message,
        ),
    };
    const { setup, dispose } = await mount(
      snapshot,
      width,
      undefined,
      sigils,
      24,
    );
    try {
      await frameAfter(setup, () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      expect(frame.match(/Read apps\/tui\/src\/frame\.tsx/gu)).toHaveLength(1);
      expect(frame).not.toContain("1 calls");
      expect(frame).not.toContain("Show all");
      const cells = captureCells(setup);
      const origins = captureSigilPlacements(cells);
      expect(origins).toHaveLength(1);
      expect(origins[0]?.x).toBe(sigilX);
      expect(
        cells.cells.find((cell) => cell.y === origins[0]?.y && cell.x === textX)
          ?.text,
      ).toBe("R");
      const expanded = await frameAfter(setup, () => {
        setup.mockInput.pressKey("g", { ctrl: true });
      });
      expect(expanded).toContain("Passed");
      expect(expanded.match(/Read apps\/tui\/src\/frame\.tsx/gu)).toHaveLength(
        1,
      );
    } finally {
      dispose();
    }
  });
