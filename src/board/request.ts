import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Ask the shell that opened this program to open a conversation. The shell
 * serves a request folder for its pane and names it in `FUNGI_PANE_REQUESTS`;
 * a program run anywhere else has no shell to ask.
 */
export async function requestConversation(
  environment: Readonly<Record<string, string | undefined>>,
  target: Readonly<{ agentId: string; sessionId: string }>,
): Promise<"asked" | "no-shell"> {
  const directory = environment.FUNGI_PANE_REQUESTS;
  if (directory === undefined || directory === "") return "no-shell";
  const name = `open-${String(Date.now())}-${String(process.pid)}`;
  // Written whole, then renamed into place, so the shell never reads half a request.
  const partial = join(directory, `${name}.partial`);
  await writeFile(
    partial,
    JSON.stringify({ open: "conversation", ...target }),
    { mode: 0o600 },
  );
  await rename(partial, join(directory, `${name}.json`));
  return "asked";
}
