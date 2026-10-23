import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePrivateLocalGitExclude,
  parseFungiMcpEndpoint,
  readProjectFungiMcpSelection,
  type PrivateFungiMcpSelection,
} from "@fungi.computer/truffle";
import writeFileAtomic from "write-file-atomic";

function connectionPath(projectRoot: string): string {
  return join(projectRoot, ".fungi", "team-mcp.json");
}

/** A project selects an address and auth kind; Local owns every credential. */
export async function readProjectMcpConnection(
  projectRoot: string,
): Promise<PrivateFungiMcpSelection | undefined> {
  try {
    const selected = await readProjectFungiMcpSelection(projectRoot);
    return selected === undefined
      ? undefined
      : {
          ...selected,
          endpoint: parseFungiMcpEndpoint(selected.endpoint).href,
        };
  } catch {
    throw new Error(
      `Invalid saved Team MCP connection in ${connectionPath(projectRoot)}; run fungi mcp forget -C ${projectRoot} to remove it`,
    );
  }
}

export async function saveProjectMcpConnection(
  projectRoot: string,
  endpoint: string,
  authentication?: "oyster-key",
): Promise<string> {
  const canonical = parseFungiMcpEndpoint(endpoint).href;
  await ensurePrivateLocalGitExclude(projectRoot);
  await mkdir(join(projectRoot, ".fungi"), { recursive: true });
  await writeFileAtomic(
    connectionPath(projectRoot),
    `${JSON.stringify({ endpoint: canonical, authentication })}\n`,
    { mode: 0o600 },
  );
  return canonical;
}

export async function forgetProjectMcpConnection(
  projectRoot: string,
): Promise<void> {
  await rm(connectionPath(projectRoot), { force: true });
}
