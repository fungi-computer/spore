import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createAppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import { createWhistle } from "@fungi.computer/whistle";
import { localExtensions } from "@fungi.computer/truffle/extensions";
import { PaneProvider, type PaneKindEntry, z } from "../src/button/index.js";
import { runFungiCli } from "../src/cli.js";
import { projectExtensionParts } from "../src/extension-command.js";
import { TuiFrame } from "../src/frame.js";
import { programPanes } from "../src/panes/terminal/index.js";
import { createTuiFixture } from "./fixture.js";
import { pressDecodedKey } from "./native-readiness.js";

// Extension manifest and actual bin/fairy-ring-tui are copied verbatim from
// Fairy Ring fab467eefaedea455a7d6650ed97d25bdb31d15a; host.mjs is
// formatted for this repository. Set FAIRY_RING_BIN and FAIRY_RING_EXTENSION
// together for the same product path with the frozen actual Rust UI. Both
// modes shadow its executable through a disposable PATH and HOME; no real
// account or Keychain operation is admitted.
const real = process.env.FAIRY_RING_BIN !== undefined;

/** Signal 0 probes liveness; only ESRCH means the process is gone. */
function processState(pid: number): "alive" | "gone" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return "gone";
    throw cause;
  }
}
const vetoPane: PaneKindEntry = {
  kind: "fixture-veto",
  launcher: {
    name: "Veto",
    description: "A later pane can refuse global quit",
    target: { kind: "fixture-veto" },
  },
  instantiate(input) {
    if (
      !z
        .object({ kind: z.literal("fixture-veto") })
        .strict()
        .safeParse(input).success
    )
      return undefined;
    return {
      key: "fixture-veto",
      title: "Veto",
      render: (kit) => {
        kit.guardQuit(() => Promise.resolve(false));
        return (
          <PaneProvider kit={kit}>
            <text>VETO_READY</text>
          </PaneProvider>
        );
      },
    };
  },
};
test.skipIf(process.platform !== "darwin")(
  real
    ? "installed Fairy Ring opens its real read-only UI through the Mac PaneKit"
    : "contributed Fairy Ring launcher opens, receives focus/input/paste, resizes and closes/reopens on Mac",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fungi-fairy-pane-"));
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    const home = join(scratch, "home");
    const project = join(scratch, "project");
    const work = join(scratch, "extension-work");
    const source = join(scratch, "fairy-ring.git");
    const bin = join(scratch, "bin");
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    let host: ReturnType<typeof createAppSurfaceCommandHost> | undefined;
    let client: ReturnType<typeof createQueryClient> | undefined;
    let quitGuard: (() => Promise<boolean>) | undefined;
    try {
      const sourceExtension = real
        ? process.env.FAIRY_RING_EXTENSION
        : resolve(import.meta.dir, "fixtures/fairy-ring-extension");
      if (!sourceExtension)
        throw new Error("Set FAIRY_RING_EXTENSION with FAIRY_RING_BIN");
      await Promise.all([
        mkdir(home),
        mkdir(project),
        mkdir(bin),
        cp(sourceExtension, work, { recursive: true }),
      ]);
      const stub = join(bin, "fairy-ring");
      if (real) {
        const realBinary = process.env.FAIRY_RING_BIN;
        if (!realBinary)
          throw new Error("The real Fairy Ring binary is missing");
        const localCore = join(bin, "fairy-ring-core");
        await cp(realBinary, localCore);
        await chmod(localCore, 0o700);
        const version = Bun.spawnSync([localCore, "--version"], {
          env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
        });
        if (version.exitCode !== 0)
          throw new Error(
            `Frozen Fairy Ring binary did not execute: ${version.stderr.toString()}`,
          );
        await writeFile(
          stub,
          `#!/bin/sh
test "$1" = tui && test "$2" = --read-only || exit 9
printf '%s\\n' "$$" > "$HOME/fairy-ring-core-pid"
exec "$(dirname "$0")/fairy-ring-core" "$@" 2>"$HOME/fairy-core-stderr"
`,
          { mode: 0o700 },
        );
        await mkdir(join(home, ".claude"));
        await writeFile(
          join(home, ".claude/.credentials.json"),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "sk-ant-oat01-SYNTHETIC-ONLY",
              refreshToken: "sk-ant-ort01-SYNTHETIC-ONLY",
              expiresAt: 1,
              scopes: ["user:inference"],
              subscriptionType: "max",
            },
          }),
        );
        await writeFile(
          join(home, ".claude.json"),
          JSON.stringify({
            numStartups: 7,
            oauthAccount: {
              emailAddress: "synthetic@example.test",
              organizationUuid: "org-synthetic",
              organizationName: "Synthetic Org",
            },
          }),
        );
        await writeFile(
          join(bin, "fungi"),
          `#!/bin/sh
printf '%s\\n' "$@" >> "$HOME/fungi-argv"
if [ "$#" -ne 2 ] || [ "$1" != account ] || [ "$2" != --json ]; then exit 97; fi
printf '%s\\n' '{"schemaVersion":1,"signedIn":true,"hub":"https://synthetic.invalid","team":{"teamId":"test-team","handle":"moss","name":"Moss Team"},"teamCount":1,"accessExpiresAt":"2001-01-01T00:00:00.000Z"}'
`,
          { mode: 0o700 },
        );
      } else {
        await writeFile(
          stub,
          `#!/bin/sh
test "$1" = tui && test "$2" = --read-only || exit 9
stty -echo
printf 'FAIRY_SYNTHETIC pid=%s\\n' "$$"
printf 'FAIRY_STTY:'; stty size
while IFS= read -r line; do
  printf 'FAIRY_INPUT:%s\\n' "$line"
  printf 'FAIRY_STTY:'; stty size
done
`,
          { mode: 0o700 },
        );
      }
      process.env.HOME = home;
      process.env.PATH = `${bin}:${previousPath ?? "/usr/bin:/bin"}`;
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.email=fixture@fungi.test",
            "-c",
            "user.name=Fixture",
            ...args,
          ],
          { cwd, encoding: "utf8" },
        );
      git(scratch, "init", "-q", "--bare", "-b", "main", source);
      git(work, "init", "-q", "-b", "main");
      git(work, "add", "-A");
      git(work, "commit", "-qm", "frozen Fairy Ring extension");
      git(work, "push", "-q", source, "HEAD:main");
      const owner = localExtensions({ home });
      const fungi = async (...argv: string[]) => {
        let output = "";
        await runFungiCli(
          argv,
          {
            cwd: project,
            stdout: {
              write(chunk) {
                output += String(chunk);
                return true;
              },
            },
          },
          { extensions: owner },
        );
        return output;
      };
      expect(
        await fungi("extension", "add", `git+file://${source}#main`),
      ).toContain("Installed fairy-ring");
      await fungi("extension", "enable", "project", "fairy-ring");
      const programs = (
        await projectExtensionParts(owner, project, (error) => {
          throw error;
        })
      ).programs;
      expect(programs.map((program) => program.name)).toEqual(["Fairy Ring"]);
      const commands = createWhistle();
      host = createAppSurfaceCommandHost(commands);
      client = createQueryClient();
      setup = await testRender(
        <QueryClientProvider client={client}>
          <TuiFrame
            session={createTuiFixture().session}
            commands={commands}
            commandHost={host}
            paneKinds={[...programPanes(programs), vetoPane]}
            setQuitGuard={(guard) => {
              quitGuard = guard;
            }}
          />
        </QueryClientProvider>,
        { width: 100, height: 30 },
      );
      const activeSetup = setup;
      const activeHost = host;
      const frame = async (check: (text: string) => boolean) => {
        const end = Date.now() + 6000;
        while (Date.now() < end) {
          await act(async () => {
            await activeSetup.renderOnce();
          });
          const text = activeSetup.captureCharFrame();
          if (check(text)) return text;
          await Bun.sleep(15);
        }
        const diagnostic = real
          ? await readFile(join(home, "fairy-core-stderr"), "utf8").catch(
              (cause: unknown) => `core stderr unreadable: ${String(cause)}`,
            )
          : "";
        throw new Error(
          `Fairy Ring frame did not settle:\n${activeSetup.captureCharFrame()}\n${diagnostic}`,
        );
      };
      const command = async (title: string) => {
        const action = activeHost
          .active()
          .palette.find((entry) => entry.title === title);
        if (!action) throw new Error(`Missing ${title}`);
        await act(async () => {
          await activeHost.execute(action.command, { origin: "menu" });
        });
      };
      const key = async (
        name: Parameters<typeof activeSetup.mockInput.pressKey>[0],
      ) =>
        pressDecodedKey(activeSetup, () => {
          activeSetup.mockInput.pressKey(name);
        });
      const open = async () => {
        await command("Open pane");
        await frame((text) => text.includes("Fairy Ring"));
        await key("ARROW_DOWN");
        await key("RETURN");
        return frame((text) =>
          text.includes(
            real ? "read-only observation" : "FAIRY_SYNTHETIC pid=",
          ),
        );
      };
      await frame((text) => text.includes("Ask anything"));
      await command("Close pane");
      await frame((text) => text.includes("No panes open"));
      const first = await open();
      const pid = real
        ? Number(await readFile(join(home, "fairy-ring-core-pid"), "utf8"))
        : Number(/FAIRY_SYNTHETIC pid=(\d+)/u.exec(first)?.[1]);
      expect(pid).toBeGreaterThan(0);
      if (real) {
        const credentialBefore = await readFile(
          join(home, ".claude/.credentials.json"),
        );
        const identityBefore = await readFile(join(home, ".claude.json"));
        await frame(
          (text) =>
            text.includes("synthetic@example.test") &&
            text.includes("Moss Team") &&
            text.includes("not added"),
        );
        await key("r");
        await frame(
          (text) =>
            text.includes("read-only observation") &&
            text.includes("synthetic@example.test"),
        );
        await activeSetup.mockInput.pasteBracketedText("pasted");
        activeSetup.resize(90, 26);
        const resized = await frame((text) =>
          text.includes("read-only observation"),
        );
        expect(resized.split("\n")).toHaveLength(27);
        expect(resized.split("\n")[0]).toHaveLength(90);
        await key("q");
        await frame((text) => text.includes("Fairy Ring exited (0)"));
        expect(
          (await readFile(join(home, ".claude/.credentials.json"))).equals(
            credentialBefore,
          ),
        ).toBe(true);
        expect(
          (await readFile(join(home, ".claude.json"))).equals(identityBefore),
        ).toBe(true);
        await assert.rejects(stat(join(home, ".local/share/fairy-ring")), {
          code: "ENOENT",
        });
        const argv = (await readFile(join(home, "fungi-argv"), "utf8"))
          .trim()
          .split("\n");
        expect(argv.length).toBeGreaterThan(0);
        expect(
          argv.every(
            (value, index) =>
              value === (index % 2 === 0 ? "account" : "--json"),
          ),
        ).toBe(true);
      } else {
        const firstSized = await frame((text) =>
          /FAIRY_STTY:\d+ \d+/u.test(text),
        );
        const size = /FAIRY_STTY:(\d+) (\d+)/u.exec(firstSized);
        expect(size).not.toBeNull();
        expect(size?.slice(1)).toEqual(["30", "100"]);
        expect(firstSized).not.toContain("Local machine");
        await key("x");
        await key("RETURN");
        await frame((text) => /FAIRY_INPUT:x(?:\s|│)/u.test(text));
        await activeSetup.mockInput.pasteBracketedText("pasted");
        await key("RETURN");
        await frame((text) => /FAIRY_INPUT:pasted(?:\s|│)/u.test(text));
        await activeSetup.mockInput.pasteBracketedText(
          "X".repeat(256 * 1024 + 1),
        );
        const denied = await frame((text) =>
          text.includes("Local terminal input was not sent"),
        );
        expect(denied).toContain("FAIRY_SYNTHETIC pid=");
        activeSetup.resize(90, 26);
        await key("r");
        await key("RETURN");
        const resized = await frame(
          (text) =>
            /FAIRY_INPUT:r(?:\s|│)/u.test(text) &&
            [...text.matchAll(/FAIRY_STTY:(\d+) (\d+)/gu)].some(
              (match) => match[1] !== size?.[1] || match[2] !== size?.[2],
            ),
        );
        const resizedSizes = [...resized.matchAll(/FAIRY_STTY:(\d+) (\d+)/gu)];
        expect(
          resizedSizes.some((match) => match[1] === "26" && match[2] === "90"),
        ).toBe(true);
        await command("Open pane");
        await frame((text) => text.includes("Veto"));
        await key("ARROW_DOWN");
        await key("ARROW_DOWN");
        await key("RETURN");
        await frame((text) => text.includes("VETO_READY"));
        expect(activeSetup.captureCharFrame()).not.toContain("Fairy Ring");
        expect(activeSetup.captureCharFrame()).not.toContain("Local machine");
        if (!quitGuard)
          throw new Error("The workspace quit guard was not registered");
        expect(await quitGuard()).toBe(false);
        expect(() => process.kill(pid, 0)).not.toThrow();
        await command("Close pane");
        await frame((text) => !text.includes("VETO_READY"));
      }
      await command("Close pane");
      await frame(
        (text) =>
          !text.includes(
            real ? "read-only observation" : "FAIRY_SYNTHETIC pid=",
          ),
      );
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        if (processState(pid) === "gone") break;
        await Bun.sleep(20);
      }
      expect(() => process.kill(pid, 0)).toThrow();
      const second = await open();
      const secondPid = real
        ? Number(await readFile(join(home, "fairy-ring-core-pid"), "utf8"))
        : Number(/FAIRY_SYNTHETIC pid=(\d+)/u.exec(second)?.[1]);
      expect(secondPid).toBeGreaterThan(0);
      expect(secondPid).not.toBe(pid);
      await command("Close pane");
      if (real) {
        const closeDeadline = Date.now() + 5000;
        let ended = false;
        while (Date.now() < closeDeadline) {
          if (processState(secondPid) === "gone") {
            ended = true;
            break;
          }
          await Bun.sleep(20);
        }
        expect(ended).toBe(true);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      setup?.renderer.destroy();
      host?.dispose();
      client?.clear();
      await rm(scratch, { recursive: true, force: true });
    }
  },
  120_000,
);
