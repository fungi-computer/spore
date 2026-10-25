import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";
import { createHash } from "node:crypto";
import { writeCliNotices } from "./package-notices.mjs";

const platform = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (
  !["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"].includes(platform)
)
  throw new Error(`Unsupported CLI native package: ${platform}`);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const buildRoot =
  platform === `${process.platform}-${process.arch}`
    ? resolve(repository, "runtimes/local/native/bin")
    : resolve(repository, `.botanical/native-build/${platform}/bin`);
const { nativeDigests } =
  await import("../../../runtimes/local/src/private-local-native-digests.js");
const expected = nativeDigests[platform];
if (
  expected?.patch === undefined ||
  (platform.startsWith("linux-") &&
    (expected.bwrap === undefined || expected.seccomp === undefined))
)
  throw new Error(`Built CLI has no native digests for ${platform}`);
const digestOf = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const assertDigest = async (path, digest) => {
  if ((await digestOf(path)) !== digest)
    throw new Error(`Native package digest mismatch with built CLI: ${path}`);
};
const build = JSON.parse(
  await readFile(resolve(buildRoot, "build.json"), "utf8"),
);
if (build.platform !== platform)
  throw new Error("Native build does not match the package target");
const output = resolve(repository, `.botanical/fungi-cli-native-${platform}`);
// Native packages share the CLI's version (apps/tui/package.json).
const { version } = JSON.parse(
  await readFile(resolve(repository, "apps/tui/package.json"), "utf8"),
);
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "bin"), { recursive: true });
await copyFile(
  resolve(buildRoot, "fungi-apply-patch"),
  resolve(output, "bin/fungi-apply-patch"),
);
await assertDigest(resolve(output, "bin/fungi-apply-patch"), expected.patch);
await copyFile(
  resolve(repository, "packages/cordyceps/native/apply-patch/LICENSE.codex"),
  resolve(output, "LICENSE.codex"),
);
const [os, cpu] = platform.split("-");
const packageExports = { "./bin/fungi-apply-patch": "./bin/fungi-apply-patch" };
if (os === "linux") packageExports["./bin/fungi-bwrap"] = "./bin/fungi-bwrap";
const linuxFiles =
  os === "linux"
    ? [
        "bin/fungi-bwrap",
        "bin/fungi-seccomp.bpf",
        "bwrap-build.json",
        "LICENSE.bubblewrap",
        "LICENSE.libcap",
        "LICENSE.sandbox-runtime",
        "SOURCE.bubblewrap.tar.xz",
        "bwrap-build-source",
      ]
    : [];
const nativeBuilds = [build];
if (os === "linux") {
  const { bwrapPin, seccompPin } =
    await import("../../../packages/cordyceps/native/bwrap/pin.mjs");
  const bwrap = JSON.parse(
    await readFile(resolve(buildRoot, "bwrap-build.json"), "utf8"),
  );
  if (bwrap.platform !== platform)
    throw new Error("Bubblewrap build does not match the package target");
  if (
    bwrap.upstream.sourceSha256 !== bwrapPin.sourceSha256 ||
    bwrap.upstream.version !== bwrapPin.version
  )
    throw new Error("Bubblewrap build does not match the current source pin");
  const digest = createHash("sha256")
    .update(await readFile(resolve(buildRoot, "fungi-bwrap")))
    .digest("hex");
  const recordedDigest = (
    await readFile(resolve(buildRoot, "fungi-bwrap.sha256"), "utf8")
  ).trim();
  if (bwrap.sha256 !== digest || recordedDigest !== digest)
    throw new Error("Bubblewrap build provenance does not match its digest");
  if (
    Object.entries(seccompPin).some(
      ([key, value]) => bwrap.seccomp?.generator?.[key] !== value,
    )
  )
    throw new Error("Seccomp filter does not match the current generator pin");
  const filterDigest = createHash("sha256")
    .update(await readFile(resolve(buildRoot, "fungi-seccomp.bpf")))
    .digest("hex");
  const recordedFilterDigest = (
    await readFile(resolve(buildRoot, "fungi-seccomp.bpf.sha256"), "utf8")
  ).trim();
  if (
    bwrap.seccomp.sha256 !== filterDigest ||
    recordedFilterDigest !== filterDigest
  )
    throw new Error("fungi-seccomp.bpf provenance does not match its digest");
  // Missing payload/source/license is a packaging failure, never a patch-only
  // Linux release or a fallback to a host's PATH.
  for (const file of linuxFiles) {
    const source = file.startsWith("bin/") ? file.slice(4) : file;
    await cp(resolve(buildRoot, source), resolve(output, file), {
      recursive: true,
    });
  }
  await assertDigest(resolve(output, "bin/fungi-bwrap"), expected.bwrap);
  await assertDigest(
    resolve(output, "bin/fungi-seccomp.bpf"),
    expected.seccomp,
  );
  nativeBuilds.push(bwrap);
}
await writeCliNotices({ repository, output, nativeBuilds });
await writeFile(
  resolve(output, "package.json"),
  JSON.stringify(
    {
      name: `@fungi.computer/spore-native-${platform}`,
      version,
      description: `Native engines for the Fungi CLI on ${platform}`,
      os: [os],
      cpu: [cpu],
      libc: os === "linux" ? ["glibc"] : undefined,
      bin: { "fungi-apply-patch": "./bin/fungi-apply-patch" },
      exports: packageExports,
      files: [
        "bin/fungi-apply-patch",
        "LICENSE.codex",
        "THIRD_PARTY_NOTICES",
        "README.md",
        ...linuxFiles,
      ],
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org",
      },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  resolve(output, "README.md"),
  `# Fungi CLI native engine (${platform})

This optional dependency supplies the native patch engine for
\`@fungi.computer/spore\`. Install the CLI to use it in a terminal or ACP editor.
${os === "linux" ? "Requires glibc 2.35 or newer." : `Requires ${cpu === "arm64" ? "Apple Silicon" : "an Intel Mac"} and macOS 13.5 or newer.`}

The engine uses pinned Codex sources with Fungi's rooted invocation wrapper.
Upstream terms are in \`LICENSE.codex\` and \`THIRD_PARTY_NOTICES\`.
${
  os === "linux"
    ? `
Linux also carries the pinned bubblewrap engine and seccomp filter and build
provenance. The runtime verifies them against the digests embedded in Fungi's
built JS, never writable sidecars. Its unmodified upstream source is in \`SOURCE.bubblewrap.tar.xz\`;
the recipe is in \`bwrap-build-source\`. Terms are in \`LICENSE.bubblewrap\`
and \`LICENSE.libcap\`; the maintained filter generator's terms are in
\`LICENSE.sandbox-runtime\`.

Limits what the agent's commands can change to your project folder and blocks their network access. They can still read other files on this computer, and this is not a security boundary against a hostile program.
Pathname Unix sockets and datagram socketpair remain known v1 limits.
`
    : ""
}
`,
);
console.log(output);
