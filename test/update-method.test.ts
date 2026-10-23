import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  findReleaseInstall,
  releaseCommandTimeout,
  type CommandRunner,
  type ReleaseInstall,
} from "../src/update.js";

const methods: readonly ReleaseInstall["method"][] = ["npm", "pnpm", "bun"];
test("global installs keep their five-minute deadline instead of the manager probe deadline", () => {
  for (const command of [
    ["npm", "install", "-g", "@fungi.computer/spore@0.0.2"],
    ["pnpm", "add", "-g", "@fungi.computer/spore@0.0.2"],
    ["bun", "add", "-g", "@fungi.computer/spore@0.0.2"],
  ]) {
    expect(releaseCommandTimeout(command)).toBe(300_000);
  }
  for (const command of [
    ["npm", "root", "-g"],
    ["npm", "prefix", "-g"],
    ["pnpm", "root", "-g"],
    ["bun", "pm", "bin", "-g"],
  ]) {
    expect(releaseCommandTimeout(command)).toBe(5_000);
  }
});

for (const method of methods) {
  test(`update recognizes the ${method} global install by its real launcher`, async () => {
    await mkdir(join(process.cwd(), ".botanical"), { recursive: true });
    const directory = await mkdtemp(
      join(process.cwd(), ".botanical/update-method-"),
    );
    try {
      const root = join(directory, "modules");
      const packageEntry = join(root, "@fungi.computer/spore");
      const pkg =
        method === "pnpm"
          ? join(directory, "content-store/spore")
          : packageEntry;
      const bin = join(directory, "bin");
      await mkdir(join(pkg, "dist"), { recursive: true });
      if (method === "pnpm") {
        await mkdir(join(root, "@fungi.computer"), { recursive: true });
        await symlink(pkg, packageEntry);
      }
      await mkdir(bin);
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@fungi.computer/spore",
          version: "0.1.1",
        }),
      );
      const launcher = join(pkg, "dist/fungi.cjs");
      await writeFile(launcher, "");
      await symlink(launcher, join(bin, "fungi"));
      const run: CommandRunner = (command) => {
        const query = command.join(" ");
        if (query === `${method} root -g`)
          return Promise.resolve({ code: 0, stdout: `${root}\n`, stderr: "" });
        if (method === "npm" && query === "npm prefix -g")
          return Promise.resolve({ code: 0, stdout: directory, stderr: "" });
        if (method === "bun" && query === "bun pm bin -g")
          return Promise.resolve({ code: 0, stdout: bin, stderr: "" });
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "not installed",
        });
      };
      const found = await findReleaseInstall(
        {
          FUNGI_LAUNCHER: join(bin, "fungi"),
          FUNGI_LAUNCHER_NODE: "/fixture/node",
        },
        run,
      );
      expect(found.method).toBe(method);
      expect(await realpath(found.launcher)).toBe(launcher);
      expect(found.launcher).toBe(
        method === "bun"
          ? join(bin, "fungi")
          : join(packageEntry, "dist/fungi.cjs"),
      );
      if (method !== "bun") {
        await assert.rejects(
          findReleaseInstall(
            {
              FUNGI_LAUNCHER: launcher,
              FUNGI_LAUNCHER_NODE: "/fixture/node",
            },
            (command) => {
              if (command.join(" ") === "npm prefix -g")
                return Promise.resolve({
                  code: 0,
                  stdout: directory,
                  stderr: "",
                });
              if (
                command.join(" ") === "npm root -g" ||
                command.join(" ") === "pnpm root -g"
              )
                return Promise.resolve({ code: 0, stdout: root, stderr: "" });
              return run(command);
            },
          ),
          /Could not identify one global/,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("unknown installations get an actionable manual command", async () => {
  await assert.rejects(
    findReleaseInstall({}, () => {
      throw new Error("No manager should run without an installed launcher");
    }),
    /npm install -g @fungi.computer\/spore/,
  );
});
