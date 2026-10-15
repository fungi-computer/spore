import { expect, test } from "bun:test";
import type { ClipboardService } from "@opentui/core";
import {
  copyWithService,
  tmuxClipboardPassthrough,
} from "../src/button/selection-copy.js";

test("OSC 52 copy adds tmux passthrough and reports a terminal attempt", async () => {
  const writes: string[] = [];
  const service: Pick<ClipboardService, "writeText"> = {
    writeText: (_text, options) => {
      expect(options.destination).toBe("all-available");
      return Promise.resolve({
        terminal: { status: "attempted", capability: "unknown" },
        host: { status: "not-attempted" },
      });
    },
  };
  expect(
    await copyWithService(service, "a URL", "/tmp/tmux", (text) =>
      writes.push(text),
    ),
  ).toBe("sent");
  expect(writes).toEqual([tmuxClipboardPassthrough("a URL")]);
  expect(writes[0]).toContain("\u001b]52;c;YSBVUkw=\u0007");
});

test("native clipboard success recovers when OSC 52 cannot be sent", async () => {
  const service: Pick<ClipboardService, "writeText"> = {
    writeText: () =>
      Promise.resolve({
        terminal: { status: "not-attempted", capability: "unsupported" },
        host: { status: "written" },
      }),
  };
  expect(
    await copyWithService(service, "local text", undefined, () => {
      throw new Error("no OSC 52");
    }),
  ).toBe("copied");
});

test("tmux passthrough works when direct OSC 52 is unsupported", async () => {
  const writes: string[] = [];
  const service: Pick<ClipboardService, "writeText"> = {
    writeText: () =>
      Promise.resolve({
        terminal: { status: "not-attempted", capability: "unsupported" },
        host: { status: "not-attempted" },
      }),
  };
  expect(
    await copyWithService(service, "through tmux", "/tmp/tmux", (text) => {
      writes.push(text);
    }),
  ).toBe("sent");
  expect(writes).toEqual([tmuxClipboardPassthrough("through tmux")]);
});

test("copy omits Kitty placeholder cells from both clipboard destinations", async () => {
  const copied: string[] = [];
  const writes: string[] = [];
  const service: Pick<ClipboardService, "writeText"> = {
    writeText: (text) => {
      copied.push(text);
      return Promise.resolve({
        terminal: { status: "attempted", capability: "unknown" },
        host: { status: "written" },
      });
    },
  };
  await copyWithService(
    service,
    "read \u{10eeee}\u0305\u0305\u{10eeee}\u0305\u030d document",
    "/tmp/tmux",
    (text) => writes.push(text),
  );
  expect(copied).toEqual(["read  document"]);
  expect(writes).toEqual([tmuxClipboardPassthrough("read  document")]);
});
