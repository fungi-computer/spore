import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "effect";
import {
  decodeBoardSettings,
  type ShipItem,
  type ShippingSource,
} from "@fungi.computer/truffle/board-shipping";
import { createBoardController } from "../src/board/controller.js";
import { project, readRows } from "../src/board/model.js";
import { createShippingReader } from "../src/board/shipping.js";
import { boardView } from "../src/board/view.js";

const item = (
  id: string,
  kind: ShipItem["kind"],
  title: string,
  at: number,
): ShipItem => ({ id, kind, title, at });

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not met");
    await Bun.sleep(5);
  }
}

/** A reader over fixed sources, ticked until every source has an answer. */
async function readerOver(sources: readonly ShippingSource[], readMs = 5_000) {
  const reader = createShippingReader(
    () => Promise.resolve(sources),
    { readMs },
    () => undefined,
  );
  await reader.tick();
  await until(() => reader.reads().length === sources.length);
  return reader;
}

test("an unknown source kind is refused with its settings path", () => {
  const refused = decodeBoardSettings({
    shipping: [
      { kind: "git", ref: "main", shows: "landed" },
      { kind: "svn", path: "." },
      { kind: "git", ref: "main", shows: "landed", extra: true },
    ],
  });
  const problems = Result.isFailure(refused) ? refused.failure : [];
  expect(problems.map((problem) => problem.split(":")[0])).toEqual([
    "board.shipping[1]",
    "board.shipping[2].extra",
  ]);
  expect(Result.isFailure(decodeBoardSettings({ shiping: [] }))).toBe(true);
  expect(
    Result.isSuccess(
      decodeBoardSettings({
        shipping: [{ kind: "git", ref: "main", shows: "released" }],
      }),
    ),
  ).toBe(true);
});

test("a failed source is a source line, never zero shipped", async () => {
  const now = Date.now();
  const reader = await readerOver([
    {
      id: "git:main",
      label: "main",
      refreshMs: 60_000,
      read: () =>
        Promise.resolve({
          state: "ok",
          items: [item("a", "landed", "feat: one", now)],
        }),
    },
    {
      id: "npm:cli",
      label: "npm: cli",
      refreshMs: 60_000,
      read: () => Promise.reject(new Error("npm is not installed")),
    },
  ]);
  const reads = reader.reads();
  expect(
    reads.map(({ label, state, detail }) => [label, state, detail]),
  ).toEqual([
    ["main", "ok", undefined],
    ["npm: cli", "failed", "npm is not installed"],
  ]);
  expect(reads[1]?.items).toEqual([]);
  const drawn = boardView(
    project(readRows([], now), reads, { lanes: false, shipping: false }),
    { width: 120, now: Date.now() },
  );
  expect(drawn.calm).toBeNull();
  const shipped = drawn.sections.find((section) => section.id === "shipped");
  expect(shipped?.title).toBe("SHIPPED TODAY 1");
  expect(shipped?.notes).toEqual(["1 landed"]);
  expect(shipped?.problems.join("\n")).toMatch(
    /^npm is not installed · could not read npm: cli \(\d\d:\d\d\)$/u,
  );
  reader.close();
});

test("a board whose only source failed says so under a heading with no count", async () => {
  const reader = await readerOver([
    {
      id: "git",
      label: "main",
      refreshMs: 60_000,
      read: () => Promise.reject(new Error("git is not installed")),
    },
  ]);
  const drawn = boardView(
    project(readRows([], Date.now()), reader.reads(), {
      lanes: false,
      shipping: false,
    }),
    { width: 120, now: Date.now() },
  );
  expect(drawn.calm).toBeNull();
  expect(drawn.sections.map(({ id, title }) => [id, title])).toEqual([
    ["shipped", "SHIPPED TODAY"],
  ]);
  reader.close();
});

test("a source that does not answer in time is failed, and the others still read", async () => {
  const reader = await readerOver(
    [
      {
        id: "slow",
        label: "slow",
        refreshMs: 60_000,
        read: (_since, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      },
      {
        id: "quick",
        label: "quick",
        refreshMs: 60_000,
        read: () => Promise.resolve({ state: "ok", items: [] }),
      },
    ],
    50,
  );
  expect(reader.reads().map(({ label, state }) => [label, state])).toEqual([
    ["slow", "failed"],
    ["quick", "ok"],
  ]);
  expect(reader.reads()[0]?.detail).toBe("did not answer in time");
  reader.close();
});

test("sources are read on their own cadence, from local midnight, and in listed order", async () => {
  const reads: number[] = [];
  const reader = await readerOver([
    {
      id: "first",
      label: "first",
      refreshMs: 60_000,
      read: (since) => {
        reads.push(since);
        return Promise.resolve({ state: "ok", items: [] });
      },
    },
  ]);
  await reader.tick();
  await reader.tick();
  await Bun.sleep(30);
  expect(reads).toHaveLength(1);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  expect(reads[0]).toBe(midnight.getTime());
  reader.close();
});

test("shows the newest three shipped items, counts them all, and the calm line names them", async () => {
  const now = Date.now();
  const landed = Array.from({ length: 5 }, (_, index) =>
    item(
      `l${String(index)}`,
      "landed",
      `landed ${String(index)}`,
      now - index * 60_000,
    ),
  );
  const reader = await readerOver([
    {
      id: "git",
      label: "main",
      refreshMs: 60_000,
      read: () =>
        Promise.resolve({
          state: "ok",
          items: [
            ...landed,
            item("r", "released", "0.5.0 released", now - 10 * 60_000),
          ],
        }),
    },
  ]);
  const board = (shipping: boolean) =>
    boardView(
      project(readRows([], now), reader.reads(), { lanes: false, shipping }),
      { width: 120, now },
    );
  expect(board(false).calm).toBe(
    "Nothing needs you. No Agents yet.  5 landed · 1 released today",
  );
  const shipped = board(true).sections[0];
  expect(shipped?.title).toBe("SHIPPED TODAY 6");
  expect(shipped?.rows.map(({ title }) => title)).toEqual([
    "landed 0",
    "landed 1",
    "landed 2",
    "landed 3",
    "landed 4",
    "0.5.0 released",
  ]);
  expect(shipped?.notes).toEqual(["5 landed · 1 released · s shows fewer"]);
  expect(board(false).sections).toEqual([]);
  expect(
    boardView(
      project(readRows([], now), reader.reads(), {
        lanes: false,
        shipping: false,
      }),
      { width: 60, now },
    ).calm,
  ).toBe("Nothing needs you. No Agents yet.  5 landed · 1 released");
  reader.close();
});

test("the controller reads a folder's Agents again and again, and a broken folder is a failed read", async () => {
  const folder = await mkdtemp(join(tmpdir(), "board-controller-"));
  try {
    const controller = createBoardController({
      root: folder,
      shipping: () => Promise.resolve([]),
      timing: { pollMs: 20 },
    });
    await until(() => controller.read() !== undefined);
    expect(controller.read()?.lanes.counts.idle).toBe(0);
    const first = controller.read()?.readAt ?? 0;
    await until(() => (controller.read()?.readAt ?? 0) > first);
    controller.toggle("lanes");
    expect(controller.read()?.expanded).toEqual({
      lanes: true,
      shipping: false,
    });
    controller.close();

    const file = join(folder, "not-a-folder");
    await writeFile(file, "");
    // A folder whose agents directory cannot be listed is a read that failed.
    const broken = createBoardController({
      root: join(file, "inside"),
      shipping: () => Promise.resolve([]),
      timing: { pollMs: 20 },
    });
    await until(() => broken.read()?.readFailure !== undefined);
    expect(broken.read()?.readFailure).toMatch(/ENOTDIR/u);
    broken.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
