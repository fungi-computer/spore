import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { CopySurface } from "../src/button/copy-surface.js";
import { DialogSurface } from "../src/button/dialog-surface.js";
import { InteractionView } from "../src/button/interaction-dialog.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

const link = "https://auth.example.test/authorize?code=long-link-for-ssh";

function Login({
  host,
}: Readonly<{ host: ReturnType<typeof createWhistleInteractionHost> }>) {
  const { colors } = useTerminalTheme("mocha");
  return (
    <CopySurface>
      <DialogSurface colors={colors} onClose={() => undefined}>
        <InteractionView
          host={host}
          colors={colors}
          onClose={() => undefined}
        />
      </DialogSurface>
    </CopySurface>
  );
}

test("login handoff offers a copy action and copies its whole URL through OSC 52", async () => {
  const host = createWhistleInteractionHost({ title: "Sign in" });
  const interaction = host.begin().interaction;
  const setup = await testRender(<Login host={host} />, {
    width: 72,
    height: 20,
  });
  const copied = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(
    true,
  );
  try {
    act(() => {
      interaction.notify({ type: "handoff", url: link, code: "ABCD-1234" });
    });
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("c copy link")),
    );
    expect(setup.captureCharFrame()).toContain("ABCD-1234");
    await act(async () => setup.mockInput.typeText("c"));
    expect(copied.mock.calls[0]?.[0]).toBe(link);
    await act(async () => setup.mockInput.typeText("x"));
    expect(copied.mock.calls[1]?.[0]).toBe("ABCD-1234");
    await act(async () =>
      setup.waitForFrame((frame) =>
        frame.includes("Copy request sent to terminal"),
      ),
    );
  } finally {
    copied.mockRestore();
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("login dialog mouse selection copies without a session frame", async () => {
  const host = createWhistleInteractionHost({ title: "Sign in" });
  const interaction = host.begin().interaction;
  const setup = await testRender(<Login host={host} />, {
    width: 72,
    height: 20,
  });
  const copied = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(
    true,
  );
  try {
    act(() => {
      interaction.notify({ type: "handoff", url: link });
    });
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("c copy link")),
    );
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) =>
      line.includes("https://auth.example.test"),
    );
    const line = lines[y];
    if (line === undefined) throw new Error("Missing login link");
    await act(async () =>
      setup.mockMouse.drag(
        line.indexOf("https://"),
        y,
        line.indexOf("https://") + 8,
        y,
      ),
    );
    expect(copied).toHaveBeenCalled();
  } finally {
    copied.mockRestore();
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("Alt+C copies the handoff URL while the paste-code input keeps its own typing", async () => {
  const host = createWhistleInteractionHost({ title: "Sign in" });
  const interaction = host.begin().interaction;
  const setup = await testRender(<Login host={host} />, {
    width: 72,
    height: 20,
  });
  const copied = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(
    true,
  );
  try {
    act(() => {
      interaction.notify({ type: "handoff", url: link });
    });
    const { answer } = await act(() => ({
      answer: interaction.prompt({
        type: "text",
        message: "Paste the code",
      }),
    }));
    await act(async () =>
      setup.waitForFrame((frame) => frame.includes("Alt+C copy link")),
    );
    act(() => {
      setup.mockInput.pressKey("c", { meta: true });
    });
    expect(copied.mock.calls[0]?.[0]).toBe(link);
    await act(async () => setup.mockInput.typeText("c123"));
    act(() => {
      setup.mockInput.pressEnter();
    });
    expect(await answer).toBe("c123");
  } finally {
    copied.mockRestore();
    act(() => {
      setup.renderer.destroy();
    });
  }
});
