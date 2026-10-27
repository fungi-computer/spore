import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import type { WhistlePrompt } from "@fungi.computer/whistle";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";
import { ConnectionRecovery, ServiceUpdated } from "../src/frame-renderer.js";
import { HostColorsContext } from "../src/button/dialog-surface.js";
import { TerminationPrompt } from "../src/panes/terminal/termination-prompt.js";
import {
  ServiceRecoveryOverlay,
  type ServiceRecoveryView,
} from "../src/panes/conversation/service-recovery.js";
import { collectRestPrompts } from "./modal-prompts.js";
import { runProducer, type ProducerRun } from "./modal-producers.js";

/** What the real Goal, Loop, Skills and question commands show. */
const restPrompts = await collectRestPrompts();

/** Set MODAL_RENDER_OUT to also save every render as a text file. */
const renderOut = process.env.MODAL_RENDER_OUT;

const sizes = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
] as const;

type Colors = ReturnType<typeof useTerminalTheme>["colors"];

async function render(
  node: (colors: Colors) => React.ReactNode,
  size: { width: number; height: number },
  surface = true,
) {
  function Frame() {
    const { colors } = useTerminalTheme("mocha");
    return (
      <HostColorsContext.Provider value={colors}>
        {surface ? (
          <DialogSurface colors={colors} onClose={() => undefined}>
            {node(colors)}
          </DialogSurface>
        ) : (
          node(colors)
        )}
      </HostColorsContext.Provider>
    );
  }
  const setup = await testRender(<Frame />, size);
  for (let pass = 0; pass < 3; pass += 1)
    await act(async () => {
      await setup.renderOnce();
    });
  const text = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();
  const type = async (keys: string) => {
    act(() => {
      void setup.mockInput.typeText(keys);
    });
    await act(async () => setup.renderOnce());
  };
  const enter = async () => {
    act(() => {
      setup.mockInput.pressEnter();
    });
    await act(async () => setup.renderOnce());
  };
  const save = async (name: string) => {
    if (renderOut === undefined) return;
    await mkdir(renderOut, { recursive: true });
    await writeFile(join(renderOut, `${name}.txt`), `${text()}\n`);
  };
  return {
    setup,
    text,
    type,
    enter,
    save,
    destroy: () => {
      act(() => {
        setup.renderer.destroy();
      });
    },
  };
}

/** Open a prompt in the interaction view and keep what the person answered. */
async function open(
  prompt: WhistlePrompt,
  size: { width: number; height: number } = sizes[0],
) {
  const host = createWhistleInteractionHost({ title: "Modal" });
  const answered: unknown[] = [];
  void host
    .begin()
    .interaction.prompt(prompt)
    .then((value) => answered.push(value));
  const modal = await render(
    (colors) => (
      <InteractionView host={host} colors={colors} onClose={() => undefined} />
    ),
    size,
  );
  return { ...modal, answered };
}

/** The same view over a prompt a real producer left pending. */
async function view(
  run: ProducerRun,
  size: { width: number; height: number } = sizes[0],
) {
  return render(
    (colors) => (
      <InteractionView
        host={run.host}
        colors={colors}
        onClose={() => undefined}
      />
    ),
    size,
  );
}

for (const size of sizes) {
  const suffix = String(size.width);
  for (const [name, prompt] of Object.entries(restPrompts)) {
    test(`${name} at ${suffix} columns`, async () => {
      const modal = await open(prompt, size);
      try {
        expect(modal.text()).toMatchSnapshot();
        await modal.save(`after-${name}-${suffix}`);
      } finally {
        modal.destroy();
      }
    });
  }

  test(`Archive and Remove extension, as the real commands ask, at ${suffix} columns`, async () => {
    const archive = await runProducer("archive", ["agent_k5f8x2"]);
    const remove = await runProducer("extensions", ["remove", "acme-tools"]);
    const pick = await runProducer("archive", []);
    const menu = await runProducer("extensions", []);
    const source = await runProducer("extensions", ["add"]);
    const scope = await runProducer("extensions", ["disable"]);
    try {
      for (const [name, run] of [
        ["archive-pick", pick],
        ["archive-confirm", archive],
        ["extensions-menu", menu],
        ["extensions-source", source],
        ["extensions-scope", scope],
        ["extensions-remove-confirm", remove],
      ] as const) {
        const modal = await view(run, size);
        try {
          expect(modal.text()).toMatchSnapshot();
          await modal.save(`after-${name}-${suffix}`);
        } finally {
          modal.destroy();
        }
      }
    } finally {
      for (const run of [archive, remove, pick, menu, source, scope])
        run.stop();
    }
  });

  test(`Service updated, Connection unavailable and the termination confirm at ${suffix} columns`, async () => {
    const updated = await render(
      () => (
        <ServiceUpdated
          message="The Fungi service was updated. Restart this window."
          exit={() => undefined}
        />
      ),
      size,
      false,
    );
    const lost = await render(
      () => (
        <ConnectionRecovery
          message="connect ECONNREFUSED 127.0.0.1:4317"
          retry={() => undefined}
          exit={() => undefined}
        />
      ),
      size,
      false,
    );
    const quit = await render(
      (colors) => (
        <TerminationPrompt
          quitting
          colors={colors}
          choices={[
            { name: "Keep shells running" },
            { name: "Quit and terminate", tone: "destructive" },
          ]}
          onCancel={() => undefined}
          onSelect={() => undefined}
        />
      ),
      size,
    );
    try {
      for (const [name, modal] of [
        ["service-updated", updated],
        ["connection-unavailable", lost],
        ["terminal-quit", quit],
      ] as const) {
        expect(modal.text()).toMatchSnapshot();
        await modal.save(`after-${name}-${suffix}`);
      }
      // Raw error text is behind d, not on the main view.
      expect(lost.text()).not.toContain("ECONNREFUSED");
      await lost.type("d");
      expect(lost.text()).toContain("ECONNREFUSED");
      expect(lost.text()).toMatchSnapshot();
      await lost.save(`after-connection-details-${suffix}`);
    } finally {
      updated.destroy();
      lost.destroy();
      quit.destroy();
    }
  });

  test(`Service recovery overlay at ${suffix} columns`, async () => {
    const views: [string, ServiceRecoveryView][] = [
      ["restarting", { phase: "restarting" }],
      [
        "stuck",
        { phase: "stuck", lastError: "connect ECONNREFUSED 127.0.0.1:4317" },
      ],
      [
        "incompatible",
        {
          phase: "incompatible",
          message: "The Fungi service was updated. Restart this window.",
        },
      ],
    ];
    for (const [name, recovery] of views) {
      const modal = await render(
        (colors) => <ServiceRecoveryOverlay view={recovery} colors={colors} />,
        size,
        false,
      );
      try {
        expect(modal.text()).toMatchSnapshot();
        await modal.save(`after-recovery-${name}-${suffix}`);
      } finally {
        modal.destroy();
      }
    }
  });
}

test("Archive: Enter keeps the Agent; only 2 archives it", async () => {
  const kept = await runProducer("archive", ["agent_k5f8x2"]);
  const modal = await view(kept);
  try {
    expect(modal.text()).toContain("▶ Keep Agent");
    await modal.enter();
    await kept.finished;
    expect(kept.archived).toEqual([]);
  } finally {
    modal.destroy();
    kept.stop();
  }
  const archived = await runProducer("archive", ["agent_k5f8x2"]);
  const second = await view(archived);
  try {
    await second.type("2");
    await archived.finished;
    expect(archived.archived).toEqual(["agent_k5f8x2"]);
  } finally {
    second.destroy();
    archived.stop();
  }
});

test("Remove extension: Enter keeps it; Esc keeps it; only 2 removes it", async () => {
  const kept = await runProducer("extensions", ["remove", "acme-tools"]);
  const modal = await view(kept);
  try {
    expect(modal.text()).toContain("▶ Keep extension");
    await modal.enter();
    await kept.finished;
    expect(kept.removed).toEqual([]);
  } finally {
    modal.destroy();
    kept.stop();
  }
  const removed = await runProducer("extensions", ["remove", "acme-tools"]);
  const second = await view(removed);
  try {
    await second.type("2");
    await removed.finished;
    expect(removed.removed).toEqual(["acme-tools"]);
  } finally {
    second.destroy();
    removed.stop();
  }
});

test("Stop loop: Enter keeps the loop; only 2 stops it", async () => {
  const keep = await open(restPrompts["loop-stop-confirm"]);
  try {
    expect(keep.text()).toContain("▶ Keep loop");
    await keep.enter();
    expect(keep.answered).toEqual([false]);
  } finally {
    keep.destroy();
  }
  const stop = await open(restPrompts["loop-stop-confirm"]);
  try {
    await stop.type("2");
    expect(stop.answered).toEqual([true]);
  } finally {
    stop.destroy();
  }
});

test("a long Agent question or loop prompt never becomes a long title", async () => {
  for (const name of ["question-long", "loop-menu"] as const) {
    const modal = await open(restPrompts[name]);
    try {
      const first = modal
        .text()
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      expect(first?.length ?? 0).toBeLessThanOrEqual(60);
    } finally {
      modal.destroy();
    }
  }
});

test("Alt+D opens details while typing: a filtered picker and a text answer", async () => {
  const many = {
    ...restPrompts["skills-list"],
    message: "Skills (7)",
    options: Array.from({ length: 7 }, (_, index) => ({
      value: `skill-${String(index)}`,
      label: `skill-${String(index)}`,
    })),
  } satisfies WhistlePrompt;
  const picker = await open(many);
  try {
    expect(picker.text()).toContain("Alt+D details");
    // A bare d is a filter letter, not Details.
    await picker.type("d");
    expect(picker.text()).toContain("/ d");
    expect(picker.text()).not.toContain("collision");
    act(() => {
      picker.setup.mockInput.pressKey("d", { meta: true });
    });
    await act(async () => picker.setup.renderOnce());
    expect(picker.text()).toContain("Details");
    expect(picker.text()).toContain("collision");
  } finally {
    picker.destroy();
  }
  const text = await open({
    ...restPrompts["question-multiple"],
    body: "Which deliverables should ship this week, given the release notes, the docs refresh, the example apps and the test plan all compete for the same two people and one reviewer?",
    bodyLabel: "Question",
  });
  try {
    expect(text.text()).toContain("Alt+D shows all");
    expect(text.text()).toContain("Esc close");
    await text.type("Docs");
    act(() => {
      text.setup.mockInput.pressKey("d", { meta: true });
    });
    await act(async () => text.setup.renderOnce());
    expect(text.text()).toContain("Details");
    await text.type("d");
    expect(text.text()).toContain("Docs");
    // The typed answer survives the trip to Details and back.
    await text.enter();
    expect(text.answered).toEqual(["Docs"]);
  } finally {
    text.destroy();
  }
});
