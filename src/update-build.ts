import { chmod, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

/** Current integration is frozen before building; the caller's checkout stays intact. */
export async function buildIntegrationCandidate(
  source: string,
  updates: string,
) {
  await mkdir(join(source, ".botanical"), { recursive: true });
  const work = await mkdtemp(join(source, ".botanical/fungi-update-"));
  const log = join(work, "build.log");
  async function run(cmd: readonly string[], cwd = source): Promise<string> {
    const child = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await writeFile(log, stdout + stderr, { flag: "a", mode: 0o600 });
    if (code !== 0)
      throw new Error(
        `Fungi update build failed (${cmd[0] ?? "command"}); inspect ${log}. The installed launcher was not changed.`,
      );
    return stdout.trim();
  }
  await run(["git", "fetch", "origin", "integration/parallel-work-tracking"]);
  const sha = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(await run(["git", "rev-parse", "FETCH_HEAD"]));
  const checkout = join(work, "source");
  await run(["git", "worktree", "add", "--detach", checkout, sha]);
  await run(["pnpm", "install", "--frozen-lockfile"], checkout);
  await run(
    ["pnpm", "turbo:run", "run", "build", "--filter=@fungi.computer/tui"],
    checkout,
  );
  await run(["pnpm", "--dir", "apps/tui", "bundle:cli"], checkout);
  const platform = `${process.platform}-${process.arch}`;
  await run(["node", "apps/tui/scripts/bundle-native.mjs", platform], checkout);
  const [packed] = z
    .array(z.object({ filename: z.string().min(1) }))
    .length(1)
    .parse(
      JSON.parse(
        await run(
          [
            "npm",
            "pack",
            `./.botanical/fungi-cli-native-${platform}`,
            "--pack-destination",
            ".botanical",
            "--json",
          ],
          checkout,
        ),
      ),
    );
  if (packed === undefined)
    throw new Error("npm pack did not return a native package");
  await run(
    [
      "npm",
      "install",
      "--prefix",
      ".botanical/fungi-cli-package",
      "--no-save",
      "--no-audit",
      "--no-fund",
      `./.botanical/${packed.filename}`,
    ],
    checkout,
  );
  const destination = await mkdtemp(join(updates, `${sha}-`));
  const packageRoot = join(destination, "package");
  await cp(join(checkout, ".botanical/fungi-cli-package"), packageRoot, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const launcher = join(packageRoot, "dist/fungi.cjs");
  await chmod(launcher, 0o755);
  const cliHash = createHash("sha256")
    .update(
      new Uint8Array(
        await Bun.file(join(packageRoot, "dist/cli.js")).arrayBuffer(),
      ),
    )
    .digest("hex");
  return { sha, launcher, destination, log, cliHash };
}
