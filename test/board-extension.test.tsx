import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createAppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import { createWhistle } from "@fungi.computer/whistle";
import { localExtensions } from "@fungi.computer/truffle/extensions";
import { projectExtensionParts } from "../src/extension-command.js";
import { TuiFrame } from "../src/frame.js";
import { programPanes } from "../src/panes/terminal/index.js";
import { createTuiFixture } from "./fixture.js";
import { waitForFrame } from "./native-readiness.js";
import { destroyTestRenderer } from "./native-renderer-cleanup.js";

const board = resolve(import.meta.dir, "../../../extensions/board");

/** The Board installed and enabled for a disposable project. */
async function installed() {
  const home = await mkdtemp(join(tmpdir(), "board-extension-home-"));
  const project = await mkdtemp(join(tmpdir(), "board-extension-project-"));
  const owner = localExtensions({ home });
  await owner.add(board);
  await owner.enableProject(project, "board");
  const parts = await projectExtensionParts(owner, project, (error) => {
    throw error;
  });
  return {
    parts,
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    },
  };
}

test("the Board ships as an installed program extension with its own key", async () => {
  const { parts, cleanup } = await installed();
  try {
    expect(parts.clients).toEqual([]);
    expect(parts.programs).toHaveLength(1);
    const [program] = parts.programs;
    expect(program).toMatchObject({
      kind: "extension:board.board",
      name: "Board",
      binding: "<leader>b",
    });
    expect(program?.command.at(0)).toMatch(/\/bin\/board-tui$/u);
    expect(program?.env.FUNGI_PROJECT_ROOT).toBeDefined();
    const [pane] = programPanes(parts.programs);
    expect(pane?.launcher).toEqual({
      name: "Board",
      description: "What needs you, what is stuck, what shipped today",
      target: { kind: "extension:board.board" },
      binding: "<leader>b",
    });
  } finally {
    await cleanup();
  }
});

test("the shell lists the Board in Open pane and binds its key", async () => {
  const { parts, cleanup } = await installed();
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const host = createAppSurfaceCommandHost(commands);
  const client = createQueryClient();
  const setup = await act(async () =>
    testRender(
      <QueryClientProvider client={client}>
        <TuiFrame
          session={fixture.session}
          commands={commands}
          commandHost={host}
          paneKinds={programPanes(parts.programs)}
        />
      </QueryClientProvider>,
      { width: 100, height: 30 },
    ),
  );
  try {
    await waitForFrame(setup, (text) => text.includes("Ask anything"));
    const open = host
      .active()
      .palette.find((row) => row.title === "Open board");
    expect(open).toBeDefined();
    const bound = host
      .active()
      .bindings.find((row) => row.title === "Open board");
    expect(bound).toBeDefined();
  } finally {
    await destroyTestRenderer(setup);
    host.dispose();
    client.clear();
    await cleanup();
  }
});

test("a program key the shell or an earlier program holds is not bound; the program still opens from the palette", async () => {
  const fixture = createTuiFixture();
  const commands = createWhistle();
  const host = createAppSurfaceCommandHost(commands);
  const client = createQueryClient();
  const program = (id: string, name: string, binding: string) => ({
    kind: `extension:${id}.${id}`,
    name,
    description: "",
    binding,
    command: ["/bin/true"],
    cwd: "/",
    env: {},
  });
  const setup = await act(async () =>
    testRender(
      <QueryClientProvider client={client}>
        <TuiFrame
          session={fixture.session}
          commands={commands}
          commandHost={host}
          paneKinds={programPanes([
            program("grab", "Grab", "<leader>o"),
            program("first", "First", "<leader>q"),
            program("second", "Second", "<leader>q"),
          ])}
        />
      </QueryClientProvider>,
      { width: 100, height: 30 },
    ),
  );
  try {
    await waitForFrame(setup, (text) => text.includes("Ask anything"));
    const active = host.active();
    const keys = (title: string) =>
      active.bindings
        .filter((row) => row.title === title)
        .map((row) => row.binding);
    expect(keys("Open pane")).toEqual(["<leader>o"]);
    expect(keys("Open grab")).toEqual([]);
    expect(keys("Open first")).toEqual(["<leader>q"]);
    expect(keys("Open second")).toEqual([]);
    for (const title of ["Open grab", "Open first", "Open second"])
      expect(active.palette.some((row) => row.title === title)).toBe(true);
  } finally {
    await destroyTestRenderer(setup);
    host.dispose();
    client.clear();
  }
});
