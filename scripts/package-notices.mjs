import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import { noticeFiles } from "../../../packages/cordyceps/native/apply-patch/notices.mjs";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function packageOwner(path, repository) {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = resolve(dir, "package.json");
    if (await exists(manifest)) {
      const value = JSON.parse(await readFile(manifest, "utf8"));
      if (value.name) return { directory: dir, ...value };
    }
    if (dir === repository) break;
  }
}

/** Preserve upstream texts for the modules actually bundled and native closure. */
export async function writeCliNotices({
  repository,
  output,
  metafile,
  nativeBuilds = [],
}) {
  const owners = new Map();
  const noticeRoot = resolve(repository, "apps/tui/npm/licenses");
  const supplements = JSON.parse(
    await readFile(resolve(noticeRoot, "upstream.json"), "utf8"),
  );
  const supplementalFiles = new Map();
  for (const group of supplements) {
    for (const notice of group.notices) {
      const file = resolve(noticeRoot, notice.file);
      const digest = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      if (digest !== notice.sha256)
        throw new Error(`Upstream notice checksum mismatch: ${notice.file}`);
    }
    for (const identity of group.packages)
      supplementalFiles.set(
        identity,
        group.notices.map((notice) => resolve(noticeRoot, notice.file)),
      );
  }
  const graphs =
    metafile === undefined
      ? []
      : [
          [metafile, repository],
          [
            "runtimes/local/dist/internal/sandbox-metafile.json",
            "runtimes/local",
          ],
          [
            "runtimes/local/dist/internal/image-fit-metafile.json",
            "runtimes/local",
          ],
          ["packages/cordyceps/dist/metafile.json", "packages/cordyceps"],
        ];
  for (const [file, cwd] of graphs) {
    const graph = JSON.parse(await readFile(resolve(repository, file), "utf8"));
    for (const input of Object.keys(graph.inputs)) {
      const path = resolve(repository, cwd, input);
      if (!(await exists(path))) continue;
      const owner = await packageOwner(path, repository);
      if (owner) {
        const upstream = resolve(repository, "packages/cordyceps/upstream");
        owners.set(owner.directory, {
          ...owner,
          noticeRoot: owner.directory.startsWith(upstream + "/")
            ? upstream
            : owner.directory,
        });
      }
    }
  }

  for (const build of nativeBuilds) {
    for (const owner of build.packages)
      owners.set(`native:${owner.name}`, {
        name: owner.name,
        nativeTexts: owner.texts,
      });
  }
  if (metafile !== undefined)
    owners.set("source:codex-seatbelt", {
      name: "@openai/codex",
      version: "0.162.1",
      nativeTexts: [],
    });
  const sections = [
    "THIRD-PARTY NOTICES\n\nUpstream notices for this package's bundled components. Fungi-owned code licensing is determined separately. Runtime packages installed by npm retain their own license files.",
  ];
  const texts = new Map();
  const missing = [];
  for (const owner of [...owners.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const identity = [owner.name, owner.version].filter(Boolean).join("@");
    const contents =
      owner.nativeTexts?.slice() ??
      (await Promise.all(
        (await noticeFiles(owner.noticeRoot ?? owner.directory)).map((file) =>
          readFile(file, "utf8"),
        ),
      ));
    contents.push(
      ...(await Promise.all(
        (supplementalFiles.get(identity) ?? []).map((file) =>
          readFile(file, "utf8"),
        ),
      )),
    );
    if (contents.length === 0) {
      if (owner.name.startsWith("@fungi.computer/")) continue;
      missing.push(owner.name);
      continue;
    }
    for (const content of new Set(contents)) {
      const names = texts.get(content) ?? new Set();
      names.add([owner.name, owner.version].filter(Boolean).join(" "));
      texts.set(content, names);
    }
  }
  if (missing.length)
    throw new Error(
      `No upstream license text found for: ${missing.join(", ")}`,
    );
  for (const [content, names] of texts) {
    sections.push(`${[...names].sort().join(", ")}\n\n${content.trim()}`);
  }
  if (metafile !== undefined) {
    // The retained OpenCode transport is part of the bundled TUI source, not
    // an npm-installed package whose own LICENSE would be carried along.
    const retained = await readFile(
      resolve(repository, "apps/tui/src/button/opencode-pty-transport.LICENSE"),
      "utf8",
    );
    sections.push(
      `anomalyco/opencode persistent-pty/daemon.ts 165cd2e832574ccdea3b311fe1a0f9db2e5c883e\n\n${retained.trim()}`,
    );
  }
  await writeFile(
    resolve(output, "THIRD_PARTY_NOTICES"),
    sections.join("\n\n---\n\n") + "\n",
  );
}
