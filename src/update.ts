import { mkdir, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { acquireNodeStoreLease } from "@fungi.computer/shiitake/node";
import { buildIntegrationCandidate } from "./update-build.js";
import {
  proveFungiCandidate,
  type FungiCandidateProof,
} from "./update-proof.js";
import { installFungiCandidate, installedFungiLink } from "./update-install.js";

/** One maintained update path: build, copied-store proof, atomic activation or rollback. */
export async function runFungiUpdate(
  options: Readonly<{
    source: string;
    project: string;
    notify: (message: string) => void;
  }>,
) {
  const updates = join(homedir(), ".fungi/updates");
  await mkdir(updates, { recursive: true, mode: 0o700 });
  const lease = acquireNodeStoreLease(join(updates, "update-owner.sqlite"));
  try {
    const link = await installedFungiLink();
    const previousTarget = await readlink(link);
    options.notify("Building current integration in an isolated checkout…");
    const candidate = await buildIntegrationCandidate(
      resolve(options.source),
      updates,
    );
    options.notify(
      "Proving resume against a private copy of the Saved Sessions…",
    );
    const proof: FungiCandidateProof = await proveFungiCandidate(
      candidate.launcher,
      resolve(options.project),
    );
    await writeFile(
      join(candidate.destination, "update-receipt.json"),
      JSON.stringify(
        {
          sourceSha: candidate.sha,
          cliSha256: candidate.cliHash,
          stateVersions: proof.stateVersions,
          buildLog: candidate.log,
          proof: proof.evidence,
          previousTarget,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    options.notify("Copied-store resume passed. Activating the new launcher…");
    await installedFungiLink();
    await installFungiCandidate(
      link,
      candidate.launcher,
      resolve(options.project),
    );
    options.notify(
      `Fungi updated to ${candidate.sha}. Run fungi resume --last to reopen the TUI.`,
    );
  } finally {
    lease.release();
  }
}
