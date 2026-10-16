import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable, PasteEvent } from "@opentui/core";
import { openMacTerminal } from "../src/button/local-terminal-mac.js";

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`Mac terminal did not show ${label}`);
    await Bun.sleep(20);
  }
}

test.skipIf(process.platform !== "darwin")(
  "a Mac contributed program owns a real controlling PTY with native display, paste, resize and close",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "fungi-mac-terminal-test-"));
    const setup = await createTestRenderer({ width: 80, height: 30 });
    const child = await openMacTerminal({
      columns: 80,
      rows: 25,
      program: {
        command: [
          "/bin/sh",
          "-c",
          [
            "stty -echo",
            "exec 3<>/dev/tty && printf 'CONTROLLING_TTY_OK\\n'",
            "test -t 0 && test -t 1 && printf 'TTY_IO_OK\\n'",
            "printf 'READY_FOR_PASTE\\n'",
            "while IFS= read -r line; do printf 'GOT:%s\\n' \"$line\"; stty size; done",
          ]
            .join("; ")
            .replace("do; ", "do "),
        ],
        cwd: home,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
      },
    });
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      cols: 80,
      rows: 25,
      width: 80,
      height: 25,
      onData: (bytes, source) => {
        if (source === "input") child.input(bytes);
      },
      onTerminalResize: (cols, rows) => {
        child.resize(cols, rows);
      },
    });
    setup.renderer.root.add(terminal);
    const unsubscribe = child.onBytes((bytes) => {
      terminal.write(bytes);
    });
    try {
      await until(
        () => terminal.screen().text.includes("READY_FOR_PASTE"),
        "ready marker",
      );
      await setup.renderOnce();
      expect(terminal.screen().text).toContain("CONTROLLING_TTY_OK");
      expect(terminal.screen().text).toContain("TTY_IO_OK");
      expect(setup.captureCharFrame()).toContain("READY_FOR_PASTE");
      terminal.handlePaste(
        new PasteEvent(new TextEncoder().encode("from-open-tui\n")),
      );
      await until(
        () => terminal.screen().text.includes("GOT:from-open-tui"),
        "paste round-trip",
      );
      terminal.width = 67;
      terminal.height = 19;
      await setup.renderOnce();
      terminal.handlePaste(
        new PasteEvent(new TextEncoder().encode("after-resize\n")),
      );
      await until(
        () =>
          terminal.screen().text.includes("GOT:after-resize") &&
          terminal.screen().text.includes("19 67"),
        "OS PTY resize",
      );
      expect(terminal.screen().columns).toBe(67);
      expect(terminal.screen().rows).toBe(19);
      expect(await child.hasRunningJobs()).toBe(false);
    } finally {
      unsubscribe();
      terminal.destroy();
      await child.close();
      setup.renderer.destroy();
      await rm(home, { recursive: true, force: true });
    }
    expect(terminal.isDestroyed).toBe(true);
    expect(setup.renderer.isDestroyed).toBe(true);
    expect(child.live).toBe(false);
  },
);

test.skipIf(process.platform !== "darwin")(
  "closing an owned Mac PTY also terminates its exact background job",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "fungi-mac-jobs-test-"));
    const child = await openMacTerminal({
      columns: 60,
      rows: 12,
      program: {
        command: [
          "/bin/sh",
          "-c",
          "sleep 60 & printf 'OWNED_JOB:%s\\n' \"$!\"; wait",
        ],
        cwd: home,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
      },
    });
    let text = "";
    const stop = child.onBytes((data) => {
      text += new TextDecoder().decode(data);
    });
    let job: number | undefined;
    try {
      await until(() => /OWNED_JOB:\d+/u.test(text), "owned job PID");
      job = Number(/OWNED_JOB:(\d+)/u.exec(text)?.[1]);
      if (!Number.isSafeInteger(job) || job < 1)
        throw new Error("The fixture did not report its job PID");
      const ownedJob = job;
      expect(await child.hasRunningJobs()).toBe(true);
      await child.close();
      await until(() => {
        try {
          process.kill(ownedJob, 0);
          return false;
        } catch {
          return true;
        }
      }, "owned job exit");
      expect(child.live).toBe(false);
    } finally {
      stop();
      await child.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "closing the Mac pane cancels queued input instead of draining stale requests",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "fungi-mac-queue-test-"));
    const child = await openMacTerminal({
      columns: 60,
      rows: 12,
      program: {
        command: ["/bin/sh", "-c", "sleep 60"],
        cwd: home,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
      },
    });
    try {
      for (let index = 0; index < 100; index += 1)
        child.input(new Uint8Array([97]));
      const started = Date.now();
      await child.close();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(child.live).toBe(false);
    } finally {
      await child.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "an oversized paste is refused and reported without terminating a healthy Mac PTY",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "fungi-mac-paste-bound-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    let child: Awaited<ReturnType<typeof openMacTerminal>> | undefined;
    try {
      child = await openMacTerminal({
        columns: 60,
        rows: 12,
        program: {
          command: ["/bin/cat"],
          cwd: home,
          env: { HOME: home, PATH: "/usr/bin:/bin" },
        },
      });
      let output = "";
      const stop = child.onBytes((data) => {
        output += new TextDecoder().decode(data);
      });
      try {
        expect(child.input(new Uint8Array(256 * 1024 + 1).fill(65))).toBe(
          false,
        );
        expect(child.live).toBe(true);
        const report = await readFile(
          join(homedir(), ".fungi/logs/tui.jsonl"),
          "utf8",
        );
        expect(report).toContain("mac-terminal-input-refused");
        expect(report).not.toContain("AAAA");
        expect(child.input(new TextEncoder().encode("still-running\n"))).toBe(
          true,
        );
        await until(
          () => output.includes("still-running"),
          "input after refused paste",
        );
        expect(child.live).toBe(true);
      } finally {
        stop();
        await child.close();
      }
      expect(child.live).toBe(false);
    } finally {
      await child?.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "native paste encoding never forwards control bytes as a PTY interrupt",
  async () => {
    const setup = await createTestRenderer({ width: 80, height: 12 });
    let encoded = "";
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      width: 80,
      height: 12,
      cols: 80,
      rows: 12,
      onData(data, source) {
        if (source === "input") encoded += Buffer.from(data).toString("latin1");
      },
    });
    try {
      setup.renderer.root.add(terminal);
      terminal.write("\x1b[?2004h");
      await setup.renderOnce();
      terminal.handlePaste(
        new PasteEvent(
          new TextEncoder().encode("safe\x1b[201~\x03\x1b[2Jtail"),
        ),
      );
      expect(encoded).toContain("safe");
      expect(encoded).toContain("tail");
      expect(encoded).not.toContain("\x03");
      expect(encoded.split("\x1b[201~")).toHaveLength(2);
    } finally {
      terminal.destroy();
      setup.renderer.destroy();
    }
  },
);
