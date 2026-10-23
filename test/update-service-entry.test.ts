import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

for (const refuse of [false, true]) {
  test(`the actual internal restart entry creates one fresh public ensure owner (${refuse ? "refusal" : "success"})`, async () => {
    const temporary = join(process.cwd(), ".botanical");
    await mkdir(temporary, { recursive: true });
    const home = await mkdtemp(join(temporary, "update-entry-"));
    const trace = join(home, "manager.log");
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          join(import.meta.dir, "fixtures/update-service-manager.ts"),
          join(import.meta.dir, "../src/cli.tsx"),
          "--internal-service-restart",
        ],
        {
          cwd: home,
          env: {
            ...process.env,
            HOME: home,
            FUNGI_TEST_UPDATE_TRACE: trace,
            FUNGI_TEST_UPDATE_REFUSE: refuse ? "1" : "0",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 4_000,
          killSignal: "SIGKILL",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stdout, stderr }).toEqual({
        exitCode: refuse ? 1 : 0,
        stdout: "",
        stderr: refuse ? "fungi: Fixture version ensure refused\n" : "",
      });
      expect(await readFile(trace, "utf8")).toBe(
        "new manager\npublic ensure\n",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
