import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createWhistle } from "@fungi.computer/whistle";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { contributeAccountCommands } from "@fungi.computer/parakeet/headless";
import { createPrivateModels } from "@fungi.computer/truffle";
import { localAccountOwner } from "@fungi.computer/truffle/login";
import { createPrivateLocalServiceManager } from "@fungi.computer/truffle/service";
import { runPrivateLocalService } from "@fungi.computer/truffle/service-process";
import { loginAllowed } from "@fungi.computer/veil/model-credentials";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

function View({
  host,
}: Readonly<{ host: ReturnType<typeof createWhistleInteractionHost> }>) {
  const { colors } = useTerminalTheme("mocha");
  return (
    <InteractionView host={host} colors={colors} onClose={() => undefined} />
  );
}

// The real /login path with nothing stubbed: the account command, the Local
// owner, the real Local service, the real runner and Pi's own OpenAI key
// prompt, drawn by the real dialog. HOME is disposable, so a credential that
// wrongly got stored would land there and not in the person's store.
test("/login with a blank OpenAI API key shows No key entered in the dialog", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-blank-key-")),
  );
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  const directory = join(root, ".fungi", "service");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manager = createPrivateLocalServiceManager({ directory });
  const service = runPrivateLocalService(directory);
  const stopped = Promise.allSettled([service]);
  let setup: Awaited<ReturnType<typeof testRender>> | undefined;
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await manager.status()) break;
      await delay(25);
    }
    assert.ok(await manager.status(), "the Local service did not start");
    const whistle = createWhistle();
    contributeAccountCommands(
      whistle,
      localAccountOwner(manager, () => createPrivateModels().getProviders()),
      {
        sourceId: "test",
        namespace: "account",
        host: "local",
        scope: "user",
        policy: { loginAllowed },
      },
    );
    const host = createWhistleInteractionHost({ title: "Sign in" });
    whistle.present(() => host.begin());
    setup = await testRender(<View host={host} />, { width: 76, height: 20 });
    const prompted = Promise.withResolvers<undefined>();
    const unsubscribe = host.subscribe(() => {
      if (host.snapshot().prompt !== undefined) prompted.resolve(undefined);
    });
    let outcome: ReturnType<typeof whistle.execute> | undefined;
    try {
      await act(async () => {
        outcome = whistle.execute("account:login", {
          origin: "slash",
          arguments: { providerId: "openai", method: "api_key" },
        });
        // The real RPC must deliver its prompt before frame assertions begin.
        await prompted.promise;
      });
    } finally {
      unsubscribe();
    }
    await act(async () => {
      await setup?.waitForFrame((frame) =>
        frame.includes("Enter OpenAI API key"),
      );
    });
    const failed = Promise.withResolvers<undefined>();
    const stopFailure = host.subscribe(() => {
      if (host.snapshot().status === "failed") failed.resolve(undefined);
    });
    try {
      await act(async () => {
        setup?.mockInput.pressEnter();
        await failed.promise;
      });
    } finally {
      stopFailure();
    }
    await act(async () => {
      await setup?.waitForFrame((frame) => frame.includes("No key entered"));
    });
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("Signed in");
    expect(frame).not.toContain("Local authentication failed");
    expect(frame).not.toContain("login complete");
    expect(host.snapshot()).toMatchObject({
      status: "failed",
      failure: "No key entered",
      retryable: true,
    });
    // The failed operation remains available until retried or dismissed.
    await act(async () => {
      host.cancel();
      expect(await outcome).toMatchObject({ status: "handled" });
    });
    expect(host.snapshot().status).toBe("cancelled");
  } finally {
    if (setup !== undefined) {
      const open = setup;
      act(() => {
        open.renderer.destroy();
      });
    }
    // The listener lives in this test process. manager.stop() waits for its
    // PID to exit, then SIGKILLs it: that would wait on and kill the runner.
    // Exercise the listener's real shutdown without process termination.
    process.emit("SIGTERM", "SIGTERM");
    assert.deepEqual(await stopped, [
      { status: "fulfilled", value: undefined },
    ]);
    process.env.HOME = savedHome;
    await rm(root, { recursive: true, force: true });
  }
});
