import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import {
  localExecRules,
  manageLocalExecRules,
  rulePrefix,
} from "@fungi.computer/truffle/rules";
import type { TuiSandboxStatus } from "../src/button/local-sandbox.js";
import { TuiFrame } from "../src/frame.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey, waitForFrame } from "./native-readiness.js";
import { executeAlias } from "./command-selection.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function renderPermissions(
  initialMode: TuiSandboxStatus["mode"] = "workspace",
  grants: readonly (readonly string[])[] = [["git", "push"]],
  initialStatus?: Promise<TuiSandboxStatus>,
) {
  const project = await mkdtemp(join(tmpdir(), "fungi-permissions-picker-"));
  cleanups.push(() => rm(project, { recursive: true, force: true }));
  // A person's approvals have already persisted these project-scoped grants.
  const approvals = localExecRules(project);
  for (const prefix of grants) approvals.add(prefix);
  const fixture = createTuiFixture({ messages: [] });
  const query = createQueryClient();
  const commands = createWhistle();
  const modeChanges: string[] = [];
  const removed: string[][] = [];
  let currentMode: TuiSandboxStatus["mode"] = initialMode;
  let firstRead = true;
  const initialReadStarted = Promise.withResolvers<undefined>();
  const source = {
    identity: "agent-permissions",
    read: () => {
      if (firstRead) {
        firstRead = false;
        initialReadStarted.resolve(undefined);
        if (initialStatus !== undefined) return initialStatus;
      }
      return Promise.resolve<TuiSandboxStatus>({
        mode: currentMode,
        available: true,
      });
    },
    setMode: (mode: TuiSandboxStatus["mode"]) => {
      modeChanges.push(mode);
      currentMode = mode;
      return Promise.resolve();
    },
    rules: {
      list: () => Promise.resolve(manageLocalExecRules(project, "list")),
      remove: (prefix: readonly string[]) => {
        removed.push([...prefix]);
        return Promise.resolve(manageLocalExecRules(project, "remove", prefix));
      },
    },
  };
  const setup = await testRender(
    <QueryClientProvider client={query}>
      <TuiFrame
        session={fixture.session}
        commands={commands}
        initialTheme="mocha"
        sandboxSource={source}
      />
    </QueryClientProvider>,
    { width: 100, height: 36 },
  );
  cleanups.push(async () => {
    act(() => {
      setup.renderer.destroy();
    });
    commands.close();
    query.clear();
    await fixture.waitForClose();
  });
  if (initialStatus === undefined)
    await waitForFrame(setup, (frame) =>
      frame.includes(
        initialMode === "full-access"
          ? "full access"
          : `${initialMode} · sandboxed`,
      ),
    );
  else await act(async () => initialReadStarted.promise);
  const open = async () => {
    expect(
      commands.snapshot().slash.some((row) => row.alias === "permissions"),
    ).toBe(true);
    await act(async () => {
      expect(
        await executeAlias(commands, "permissions", { origin: "slash" }),
      ).toEqual({ status: "handled" });
    });
    return waitForFrame(setup, (text) => text.includes("Current mode:"));
  };
  return { setup, fixture, commands, source, modeChanges, removed, open };
}

test.each(["agent", "programmatic"] as const)(
  "%s execution of tui permissions needs a person and writes nothing",
  async (origin) => {
    const { setup, commands, source, modeChanges, removed } =
      await renderPermissions();
    await act(async () => {
      // The native pane host scopes { namespace: "tui", id: "permissions" }.
      expect(await executeAlias(commands, "permissions", { origin })).toEqual({
        status: "failed",
        error: {
          code: "command_failed",
          message: "Managing permissions needs a person.",
        },
      });
    });
    expect(modeChanges).toEqual([]);
    expect(removed).toEqual([]);
    expect((await source.read()).mode).toBe("workspace");
    expect(await source.rules.list()).toEqual([["git", "push"]]);
    expect(setup.captureCharFrame()).not.toContain("Current mode:");
    expect(setup.captureCharFrame()).toContain("workspace · sandboxed");
  },
);

test("/permissions shows Agent mode and project rules; Enter keeps both", async () => {
  const { setup, modeChanges, removed, open } = await renderPermissions();
  const frame = await open();
  expect(frame).toContain("Full access");
  expect(frame).toContain("Read-only");
  expect(frame.toLowerCase()).toContain("always-allow rules");
  expect(frame).toContain("git push");
  expect(frame.split("\n").find((line) => line.includes("▶"))).toContain(
    "Workspace",
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressEnter();
  });
  await waitForFrame(
    setup,
    (text) => !text.includes("Current mode: Workspace"),
  );
  expect(modeChanges).toEqual([]);
  expect(removed).toEqual([]);
  expect(setup.captureCharFrame()).toContain("workspace · sandboxed");
});

test("choosing Read-only changes the Agent mode and footer without remounting", async () => {
  const { setup, fixture, source, modeChanges, open } =
    await renderPermissions();
  await open();
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("1");
  });
  await waitForFrame(
    setup,
    (frame) =>
      frame.includes("read-only · sandboxed") &&
      !frame.includes("Current mode:"),
  );
  expect(modeChanges).toEqual(["read-only"]);
  expect((await source.read()).mode).toBe("read-only");
  expect(fixture.watchCalls()).toBe(1);
  const reopened = await open();
  expect(reopened).toContain("Current mode: Read-only");
  expect(reopened.split("\n").find((line) => line.includes("▶"))).toContain(
    "Read-only",
  );
});

test("Full access requires a separate explicit confirmation; Enter keeps Workspace", async () => {
  const { setup, source, modeChanges, open } = await renderPermissions();
  await open();
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("3");
  });
  const confirmation = await waitForFrame(setup, (frame) =>
    frame.includes("Switch to Full access?"),
  );
  expect(confirmation).toContain("Outside the sandbox, as you");
  expect(confirmation).toContain("files, network and credentials");
  expect(confirmation.split("\n").find((line) => line.includes("▶"))).toContain(
    "Keep Workspace",
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressEnter();
  });
  await waitForFrame(setup, (frame) =>
    frame.includes("Current mode: Workspace"),
  );
  expect(modeChanges).toEqual([]);
  expect((await source.read()).mode).toBe("workspace");
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("3");
  });
  await waitForFrame(setup, (frame) =>
    frame.includes("Switch to Full access?"),
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("2");
  });
  await waitForFrame(
    setup,
    (frame) =>
      frame.includes("full access") && !frame.includes("Current mode:"),
  );
  expect(modeChanges).toEqual(["full-access"]);
  expect((await source.read()).mode).toBe("full-access");
});

test("Enter on an Agent already in Full access does not change or reconfirm it", async () => {
  const { setup, modeChanges, open } = await renderPermissions("full-access");
  const frame = await open();
  expect(frame.split("\n").find((line) => line.includes("▶"))).toContain(
    "Full access",
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressEnter();
  });
  await waitForFrame(setup, (text) => !text.includes("Current mode:"));
  expect(modeChanges).toEqual([]);
  expect(setup.captureCharFrame()).not.toContain("Switch to Full access?");
});

test("removing a project rule needs explicit confirmation and persists on reopen", async () => {
  const { setup, source, removed, modeChanges, open } =
    await renderPermissions();
  await open();
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("4");
  });
  const confirmation = await waitForFrame(setup, (frame) =>
    frame.includes("Remove Always-allow rule?"),
  );
  expect(confirmation).toContain("git push");
  expect(confirmation.replace(/\s+/gu, " ")).toContain(
    "Workspace Agent in this project",
  );
  expect(confirmation.split("\n").find((line) => line.includes("▶"))).toContain(
    "Keep rule",
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressEnter();
  });
  await waitForFrame(setup, (frame) =>
    frame.includes("Current mode: Workspace"),
  );
  expect(removed).toEqual([]);
  expect(await source.rules.list()).toEqual([["git", "push"]]);
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("4");
  });
  await waitForFrame(setup, (frame) =>
    frame.includes("Remove Always-allow rule?"),
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("2");
  });
  await waitForFrame(setup, (frame) => !frame.includes("Current mode:"));
  expect(removed).toEqual([["git", "push"]]);
  expect(await source.rules.list()).toEqual([]);
  const reopened = await open();
  expect(reopened).toContain("No Always-allow rules in this project.");
  expect(reopened).not.toContain("Remove “git push”");
  expect(modeChanges).toEqual([]);
});

test("a valid rule whose JSON exceeds prompt text limits remains safely removable", async () => {
  // Local offers the first two argv tokens. Newlines are valid argument bytes;
  // JSON escaping expands this legal 4096-character token beyond prompt limits.
  const argv = ["printf", "\n".repeat(4096)];
  expect(rulePrefix(argv)).toEqual(argv);
  const { setup, source, removed, modeChanges, open } = await renderPermissions(
    "workspace",
    [argv],
  );
  expect(await source.rules.list()).toEqual([argv]);
  await open();
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("4");
  });
  const confirmation = await waitForFrame(setup, (frame) =>
    frame.includes("Remove Always-allow rule?"),
  );
  expect(confirmation.split("\n").find((line) => line.includes("▶"))).toContain(
    "Keep rule",
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressEnter();
  });
  await waitForFrame(setup, (frame) =>
    frame.includes("Current mode: Workspace"),
  );
  expect(removed).toEqual([]);
  expect(await source.rules.list()).toEqual([argv]);
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("4");
  });
  await waitForFrame(setup, (frame) =>
    frame.includes("Remove Always-allow rule?"),
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("2");
  });
  await waitForFrame(setup, (frame) => !frame.includes("Current mode:"));
  expect(removed).toEqual([argv]);
  expect(await source.rules.list()).toEqual([]);
  expect(modeChanges).toEqual([]);
});

test("a delayed initial status reply cannot replace the mode just saved through /permissions", async () => {
  // The Local HTTP status endpoint can snapshot Workspace before a mode write,
  // then deliver that first response after the person's newer selection.
  const initial = Promise.withResolvers<TuiSandboxStatus>();
  const { setup, modeChanges, open } = await renderPermissions(
    "workspace",
    [],
    initial.promise,
  );
  await open();
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("1");
  });
  expect(modeChanges).toEqual(["read-only"]);
  await act(async () => {
    initial.resolve({ mode: "workspace", available: true });
    await initial.promise;
  });
  await waitForFrame(
    setup,
    (frame) =>
      frame.includes("read-only · sandboxed") &&
      !frame.includes("Current mode:"),
  );
  expect(setup.captureCharFrame()).not.toContain("workspace · sandboxed");
});

test("a refused mode change stays explicit and leaves the saved mode unchanged", async () => {
  const { setup, source, modeChanges, open } = await renderPermissions();
  source.setMode = () =>
    Promise.reject(new Error("Sandbox unavailable: Read-only was not saved."));
  await open();
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("1");
  });
  const failure = await waitForFrame(setup, (frame) =>
    frame.includes("Sandbox unavailable: Read-only was not saved."),
  );
  expect(failure).toContain("workspace · sandboxed");
  expect(modeChanges).toEqual([]);
  expect((await source.read()).mode).toBe("workspace");
  // Shared failure view defaults to Try again; choose its explicit Close row.
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("2");
  });
  await waitForFrame(setup, (frame) => !frame.includes("Sandbox unavailable:"));
  const reopened = await open();
  expect(reopened).toContain("Current mode: Workspace");
});

test("a compact terminal keeps the Full access warning and safe choice; Escape writes nothing", async () => {
  const { setup, source, modeChanges, removed, open } =
    await renderPermissions();
  act(() => {
    setup.resize(80, 18);
  });
  const picker = await open();
  expect(picker).toContain("Read-only");
  expect(picker).toContain("Full access");
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressKey("3");
  });
  const confirmation = await waitForFrame(
    setup,
    (frame) =>
      frame.includes("Switch to Full access?") &&
      frame.includes("Keep Workspace"),
  );
  expect(confirmation.replace(/\s+/gu, " ")).toContain(
    "files, network and credentials",
  );
  await pressDecodedKey(setup, () => {
    setup.mockInput.pressEscape();
  });
  await waitForFrame(
    setup,
    (frame) => !frame.includes("Switch to Full access?"),
  );
  expect(modeChanges).toEqual([]);
  expect(removed).toEqual([]);
  expect((await source.read()).mode).toBe("workspace");
});
